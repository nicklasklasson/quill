// QuillAX: a small helper that gives the Electron app access to the macOS Accessibility API.
//
// It is started as a child process by main.js and speaks a line-based JSON protocol:
//   stdin:  one JSON object per line, {"id": 1, "op": "focus", ...}
//   stdout: one JSON object per line, either a reply {"id": 1, ...} or an event {"event": "value", ...}
//
// Nothing here touches the network.
//
// Two jobs:
//   1. Monitor: follow which element has keyboard focus in the frontmost app, and report it with
//      a "focus" event (role, whether it's an editable text field, its position) whenever it
//      changes. These events never include the field's text. Apps on the excluded list aren't
//      inspected at all.
//   2. Watch: for the one field Quill is attached to, report its text as it changes ("value"),
//      its position ("frame"), and write corrected text back into it.
//
// Operations:
//   trusted                              -> {"trusted": bool}
//   config  {excluded: [bundleId]}       -> apps the monitor must not look into
//   focus   {ignoreExclusions?}          -> the focused element right now, including its text
//   watch   {handle}                     -> start watching; reply includes the current text
//   unwatch                              -> stop watching
//   set     {handle, text, caret?}       -> write text; reply {"ok": bool, "method": "..."}
//   activate {pid}                       -> bring that app to the front
//   keys    {pid, combos: [["cmd","a"]]} -> send keystrokes to that app
//   quit

import Cocoa
import ApplicationServices
import Foundation

// MARK: - Output

func emit(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func reply(_ id: Any?, _ fields: [String: Any]) {
    var object = fields
    object["id"] = id ?? NSNull()
    emit(object)
}

// MARK: - Accessibility helpers

let AX_TIMEOUT: Float = 0.5 // seconds; a hung app must not freeze the helper

func appElement(_ pid: pid_t) -> AXUIElement {
    let element = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(element, AX_TIMEOUT)
    return element
}

func axCopy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    return error == .success ? value : nil
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let value = axCopy(element, attribute) else { return nil }
    if CFGetTypeID(value) == CFStringGetTypeID() { return value as? String }
    if CFGetTypeID(value) == CFAttributedStringGetTypeID() { return (value as? NSAttributedString)?.string }
    return nil
}

func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
    guard let value = axCopy(element, attribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
}

func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
    guard let value = axCopy(element, attribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
}

func axRange(_ element: AXUIElement, _ attribute: String) -> CFRange? {
    guard let value = axCopy(element, attribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var range = CFRange(location: 0, length: 0)
    return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
}

func axSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var settable = DarwinBoolean(false)
    let error = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
    return error == .success && settable.boolValue
}

func frameDictionary(_ element: AXUIElement) -> [String: Any]? {
    guard let position = axPoint(element, kAXPositionAttribute),
          let size = axSize(element, kAXSizeAttribute) else { return nil }
    return ["x": Double(position.x), "y": Double(position.y), "w": Double(size.width), "h": Double(size.height)]
}

func rangeDictionary(_ range: CFRange?) -> Any {
    guard let range = range else { return NSNull() }
    return ["start": range.location, "length": range.length]
}

let editableRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

/// Whether an element is something we can read and write text in. Doesn't read the text itself.
func isEditable(_ element: AXUIElement, role: String?) -> Bool {
    if let role = role, editableRoles.contains(role) { return true }
    // Web content and custom editors often use other roles but still expose a settable string value.
    if axSettable(element, kAXValueAttribute) || axSettable(element, kAXSelectedTextAttribute) {
        if let value = axCopy(element, kAXValueAttribute) {
            return CFGetTypeID(value) == CFStringGetTypeID() || CFGetTypeID(value) == CFAttributedStringGetTypeID()
        }
    }
    if let editable = axCopy(element, "AXEditable"), CFGetTypeID(editable) == CFBooleanGetTypeID() {
        return CFBooleanGetValue((editable as! CFBoolean))
    }
    return false
}

/// Address bars and search boxes are often plain text fields; recognise them by their label.
func looksLikeSearch(_ element: AXUIElement) -> Bool {
    for attribute in [kAXDescriptionAttribute, kAXTitleAttribute, kAXPlaceholderValueAttribute, kAXIdentifierAttribute] {
        if let label = axString(element, attribute),
           label.range(of: "search|address|url|omnibox|find in", options: [.regularExpression, .caseInsensitive]) != nil {
            return true
        }
    }
    return false
}

func isSelf(_ pid: pid_t) -> Bool {
    return pid == getpid() || pid == getppid()
}

// MARK: - State

final class Helper {
    static let shared = Helper()

    var nextHandle = 1
    var elements: [Int: AXUIElement] = [:]
    var elementPids: [Int: pid_t] = [:]
    var excluded: Set<String> = []

    var watchedHandle: Int?
    var observer: AXObserver?
    var pollTimer: Timer?
    var lastValue: String?
    var lastRange: CFRange?
    var lastFrame: [String: Any]?

    func register(_ element: AXUIElement, pid: pid_t) -> Int {
        for (handle, known) in elements where CFEqual(known, element) { return handle }
        let handle = nextHandle
        nextHandle += 1
        elements[handle] = element
        elementPids[handle] = pid
        if elements.count > 64 {
            for key in elements.keys.sorted().prefix(elements.count - 32) where key != watchedHandle {
                elements.removeValue(forKey: key)
                elementPids.removeValue(forKey: key)
            }
        }
        return handle
    }

    /// Describe the element that has keyboard focus in the frontmost app.
    func describeFocused(includeValue: Bool, honorExclusions: Bool) -> [String: Any] {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return ["found": false, "reason": "no-frontmost-app"]
        }
        let pid = app.processIdentifier
        let bundleId = app.bundleIdentifier ?? ""
        var result: [String: Any] = [
            "found": false,
            "pid": Int(pid),
            "app": app.localizedName ?? "",
            "bundleId": bundleId,
            "self": isSelf(pid),
        ]
        if isSelf(pid) {
            result["reason"] = "self"
            return result
        }
        if honorExclusions && excluded.contains(bundleId) {
            result["reason"] = "excluded"
            return result
        }
        guard let focusedRef = axCopy(appElement(pid), kAXFocusedUIElementAttribute) else {
            result["reason"] = "no-focused-element"
            return result
        }
        let element = focusedRef as! AXUIElement
        AXUIElementSetMessagingTimeout(element, AX_TIMEOUT)
        let role = axString(element, kAXRoleAttribute)
        let subrole = axString(element, kAXSubroleAttribute)
        result["found"] = true
        result["role"] = role ?? ""
        result["subrole"] = subrole ?? ""
        result["editable"] = isEditable(element, role: role)
        result["secure"] = subrole == "AXSecureTextField" || role == "AXSecureTextField"
        result["search"] = role == "AXSearchField" || subrole == "AXSearchField" || looksLikeSearch(element)
        result["handle"] = register(element, pid: pid)
        result["frame"] = frameDictionary(element) ?? NSNull()
        if includeValue {
            result["value"] = axString(element, kAXValueAttribute) ?? NSNull()
            result["selectedRange"] = rangeDictionary(axRange(element, kAXSelectedTextRangeAttribute))
        }
        return result
    }

    // MARK: Watching one field

    func watch(_ handle: Int) -> [String: Any] {
        unwatch()
        guard let element = elements[handle], let pid = elementPids[handle] else { return ["ok": false] }
        watchedHandle = handle
        lastValue = axString(element, kAXValueAttribute)
        lastRange = axRange(element, kAXSelectedTextRangeAttribute)
        lastFrame = frameDictionary(element)

        var created: AXObserver?
        if AXObserverCreate(pid, watchCallback, &created) == .success, let observer = created {
            self.observer = observer
            let app = appElement(pid)
            AXObserverAddNotification(observer, element, kAXValueChangedNotification as CFString, nil)
            AXObserverAddNotification(observer, element, kAXSelectedTextChangedNotification as CFString, nil)
            AXObserverAddNotification(observer, element, kAXUIElementDestroyedNotification as CFString, nil)
            AXObserverAddNotification(observer, app, kAXWindowMovedNotification as CFString, nil)
            AXObserverAddNotification(observer, app, kAXWindowResizedNotification as CFString, nil)
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        }

        // Polling backs up the observer: Chromium-based apps don't always send notifications.
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            self?.poll()
        }
        return [
            "ok": true,
            "value": lastValue ?? NSNull(),
            "selectedRange": rangeDictionary(lastRange),
            "frame": lastFrame ?? NSNull(),
        ]
    }

    func unwatch() {
        pollTimer?.invalidate()
        pollTimer = nil
        if let observer = observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        }
        observer = nil
        watchedHandle = nil
        lastValue = nil
        lastRange = nil
        lastFrame = nil
    }

    func handleWatchNotification(_ name: String, element: AXUIElement) {
        guard let handle = watchedHandle else { return }
        switch name {
        case kAXValueChangedNotification, kAXSelectedTextChangedNotification:
            reportValue(handle)
        case kAXUIElementDestroyedNotification:
            if let watched = elements[handle], CFEqual(watched, element) {
                emit(["event": "lost", "handle": handle, "reason": "destroyed"])
                unwatch()
            }
        case kAXWindowMovedNotification, kAXWindowResizedNotification:
            reportFrame(handle)
        default:
            break
        }
    }

    func poll() {
        guard let handle = watchedHandle else { return }
        reportValue(handle)
        reportFrame(handle)
    }

    func reportValue(_ handle: Int) {
        guard let element = elements[handle] else { return }
        let value = axString(element, kAXValueAttribute)
        let range = axRange(element, kAXSelectedTextRangeAttribute)
        let rangeChanged: Bool
        if let a = lastRange, let b = range { rangeChanged = a.location != b.location || a.length != b.length }
        else { rangeChanged = (lastRange == nil) != (range == nil) }
        if value != lastValue || rangeChanged {
            lastValue = value
            lastRange = range
            emit(["event": "value", "handle": handle, "value": value ?? NSNull(), "selectedRange": rangeDictionary(range)])
        }
    }

    func reportFrame(_ handle: Int) {
        guard let element = elements[handle] else { return }
        let frame = frameDictionary(element)
        if let frame = frame, let last = lastFrame {
            let same = ["x", "y", "w", "h"].allSatisfy { (frame[$0] as? Double) == (last[$0] as? Double) }
            if same { return }
        } else if frame == nil && lastFrame == nil {
            return
        }
        lastFrame = frame
        emit(["event": "frame", "handle": handle, "frame": frame ?? NSNull()])
    }

    // MARK: Writing

    func setText(_ handle: Int, text: String, caret: Int?) -> [String: Any] {
        guard let element = elements[handle] else { return ["ok": false, "error": "unknown-handle"] }
        let target = text
        let oldLength = (axString(element, kAXValueAttribute) ?? "").utf16.count

        func verify() -> Bool {
            return axString(element, kAXValueAttribute) == target
        }
        func placeCaret() {
            let location = caret.map { min(max($0, 0), target.utf16.count) } ?? target.utf16.count
            var range = CFRange(location: location, length: 0)
            if let value = AXValueCreate(.cfRange, &range) {
                AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value)
            }
        }

        // 1. Plain value replacement. Works in most native apps.
        if axSettable(element, kAXValueAttribute) {
            let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, target as CFTypeRef)
            if error == .success && verify() {
                placeCaret()
                lastValue = target
                return ["ok": true, "method": "value"]
            }
        }

        // 2. Select everything and replace the selection. Works in many web views.
        var all = CFRange(location: 0, length: oldLength)
        if let rangeValue = AXValueCreate(.cfRange, &all) {
            AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, rangeValue)
            let error = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, target as CFTypeRef)
            if error == .success && verify() {
                placeCaret()
                lastValue = target
                return ["ok": true, "method": "selection"]
            }
        }

        return ["ok": false, "error": "not-settable"]
    }

    func activate(_ pid: pid_t) -> Bool {
        guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
        return app.activate(options: [])
    }

    func sendKeys(_ pid: pid_t, combos: [[String]]) {
        let keyCodes: [String: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
            "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
            "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
            "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "l": 37,
            "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
            ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "escape": 53,
            "left": 123, "right": 124, "down": 125, "up": 126,
        ]
        let source = CGEventSource(stateID: .combinedSessionState)
        for combo in combos {
            var flags = CGEventFlags()
            var key: CGKeyCode?
            for part in combo {
                switch part.lowercased() {
                case "cmd", "command": flags.insert(.maskCommand)
                case "shift": flags.insert(.maskShift)
                case "alt", "option": flags.insert(.maskAlternate)
                case "ctrl", "control": flags.insert(.maskControl)
                default: key = keyCodes[part.lowercased()]
                }
            }
            guard let code = key else { continue }
            if let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true) {
                down.flags = flags
                down.postToPid(pid)
            }
            if let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) {
                up.flags = flags
                up.postToPid(pid)
            }
            usleep(30_000)
        }
    }
}

let watchCallback: AXObserverCallback = { _, element, notification, _ in
    Helper.shared.handleWatchNotification(notification as String, element: element)
}

// MARK: - Focus monitor

final class Monitor {
    static let shared = Monitor()

    var running = false
    var appPid: pid_t = 0
    var observer: AXObserver?
    var lastFocused: AXUIElement?
    var timer: Timer?

    func start() {
        guard !running else { return }
        running = true
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.follow(app)
        }
        if let app = NSWorkspace.shared.frontmostApplication { follow(app) }
        // Backup for apps that don't send focus notifications reliably.
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.poll() }
    }

    func follow(_ app: NSRunningApplication) {
        let pid = app.processIdentifier
        detach()
        appPid = pid
        let bundleId = app.bundleIdentifier ?? ""
        if !isSelf(pid) && !Helper.shared.excluded.contains(bundleId) {
            let element = appElement(pid)
            // Electron and Chromium apps (Slack, Teams, Claude, VS Code, browsers) only build their
            // accessibility tree when asked to.
            AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            var created: AXObserver?
            if AXObserverCreate(pid, monitorCallback, &created) == .success, let obs = created {
                AXObserverAddNotification(obs, element, kAXFocusedUIElementChangedNotification as CFString, nil)
                CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
                observer = obs
            }
        }
        check(force: true)
    }

    func detach() {
        if let observer = observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        }
        observer = nil
    }

    func poll() {
        if let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != appPid {
            follow(app)
            return
        }
        check(force: false)
    }

    func currentFocused() -> AXUIElement? {
        guard appPid != 0, !isSelf(appPid) else { return nil }
        if let app = NSRunningApplication(processIdentifier: appPid),
           Helper.shared.excluded.contains(app.bundleIdentifier ?? "") { return nil }
        guard let ref = axCopy(appElement(appPid), kAXFocusedUIElementAttribute) else { return nil }
        return (ref as! AXUIElement)
    }

    /// Report the focused element if it changed (or always, when forced).
    func check(force: Bool) {
        let focused = currentFocused()
        let same: Bool
        if let a = focused, let b = lastFocused { same = CFEqual(a, b) }
        else { same = focused == nil && lastFocused == nil }
        if same && !force { return }
        lastFocused = focused
        var event = Helper.shared.describeFocused(includeValue: false, honorExclusions: true)
        event["event"] = "focus"
        emit(event)
    }
}

let monitorCallback: AXObserverCallback = { _, _, _, _ in
    Monitor.shared.check(force: false)
}

// MARK: - Command loop

func runCommand(_ command: [String: Any]) {
    let id = command["id"]
    let op = command["op"] as? String ?? ""
    let helper = Helper.shared
    switch op {
    case "trusted":
        reply(id, ["trusted": AXIsProcessTrusted(), "pid": Int(getpid())])
    case "config":
        if let list = command["excluded"] as? [String] { helper.excluded = Set(list) }
        if Monitor.shared.running, let app = NSWorkspace.shared.frontmostApplication { Monitor.shared.follow(app) }
        reply(id, ["ok": true])
    case "focus":
        let ignore = command["ignoreExclusions"] as? Bool ?? false
        reply(id, helper.describeFocused(includeValue: true, honorExclusions: !ignore))
    case "watch":
        let h = command["handle"] as? Int ?? -1
        reply(id, helper.watch(h))
    case "unwatch":
        helper.unwatch()
        reply(id, ["ok": true])
    case "set":
        let h = command["handle"] as? Int ?? -1
        let text = command["text"] as? String ?? ""
        reply(id, helper.setText(h, text: text, caret: command["caret"] as? Int))
    case "activate":
        let pid = pid_t(command["pid"] as? Int ?? 0)
        reply(id, ["ok": helper.activate(pid)])
    case "keys":
        let pid = pid_t(command["pid"] as? Int ?? 0)
        let combos = command["combos"] as? [[String]] ?? []
        helper.sendKeys(pid, combos: combos)
        reply(id, ["ok": true])
    case "quit":
        reply(id, ["ok": true])
        exit(0)
    default:
        reply(id, ["error": "unknown-op", "op": op])
    }
}

// Read commands on a background thread; run them on the main thread where the observers live.
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        DispatchQueue.main.async { runCommand(object) }
    }
    DispatchQueue.main.async { exit(0) }
}

emit(["event": "ready", "trusted": AXIsProcessTrusted(), "pid": Int(getpid())])

// Start following focus as soon as we're allowed to. If the permission is granted later, notice
// it without a restart.
if AXIsProcessTrusted() {
    Monitor.shared.start()
} else {
    Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { timer in
        if AXIsProcessTrusted() {
            timer.invalidate()
            emit(["event": "trusted", "trusted": true])
            Monitor.shared.start()
        }
    }
}

RunLoop.main.run()
