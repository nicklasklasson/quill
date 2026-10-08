// Quill: a private writing assistant. Press the hotkey in any text field and a small panel
// appears next to it with grammar fixes and rewrite suggestions. Everything runs on this Mac:
// Harper (WebAssembly in this process) for instant checks, and a language model run by the
// bundled llama.cpp engine for deeper checks and rewrites.

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, clipboard, shell,
  systemPreferences, nativeImage, nativeTheme, net,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AXClient, helperPath } = require('./src/ax');
const { Checker, applySuggestion } = require('./src/lint');
const { Engine } = require('./src/engine');
const { ModelStore, CATALOG } = require('./src/models');
const prompts = require('./src/prompts');
const { suggestionsFromRewrite, rebase, overlaps } = require('./src/modelcheck');
const { Settings } = require('./src/settings');

const PANEL_WIDTH = 380;
const PANEL_MIN_HEIGHT = 120;
const PANEL_MAX_HEIGHT = 680;
const GAP = 10;
const BADGE_SIZE = 28;
const MODEL_CHECK_DELAY_MS = 1500;
const MODEL_CHECK_MAX_CHARS = 4000;

let settings;
let tray;
let panel;
let badgeWin;
let ax;
let engine;
let models;
const checker = new Checker();

// What the panel is currently attached to.
const session = {
  mode: 'none',        // none | watch | scratch
  handle: null,
  pid: null,
  appName: '',
  bundleId: '',
  frame: null,
  panelOpen: false,    // in watch mode: the full panel is showing (otherwise just the badge)
  textSource: 'value', // how the helper reads this field: value | range | children | none
  text: '',
  harperIssues: [],
  harperText: null,
  truncated: false,
  lintTimer: null,
  lintSeq: 0,
  modelIssues: [],
  modelCheckedText: null,
  modelState: 'idle',  // idle | waiting | starting | checking | error
  modelTimer: null,
  modelAbort: null,
  rewriteAbort: null,
};

const status = {
  helper: 'starting',  // starting | ready | missing | failed
  trusted: false,
  checkerReady: false,
  hotkeyOk: true,
  engine: 'stopped',   // stopped | starting | ready | error
  engineError: null,
};

// ---------------------------------------------------------------------------------------------
// App lifecycle

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => toggle());
  app.whenReady().then(start);
}

app.on('window-all-closed', () => { /* keep running in the menu bar */ });
// Closing the panel normally only hides it. While quitting, windows must really close, or the
// quit is cancelled (which made "Quit Quill" do nothing in 0.1.5).
let quitting = false;
app.on('before-quit', () => { quitting = true; });
let startedAt = Date.now();
// Clicking the Dock icon (or opening Quill again while it runs) shows the panel or Settings.
app.on('activate', () => {
  if (!settings || Date.now() - startedAt < 3000) return; // the activation at launch
  if (session.mode === 'watch' || session.mode === 'scratch') openPanel();
  else openSettings();
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (ax) ax.stop();
  if (engine) engine.stop();
});

async function start() {
  settings = new Settings(app.getPath('userData'));
  startedAt = Date.now();
  applyDockVisibility();
  setApplicationMenu();

  models = new ModelStore(path.join(app.getPath('userData'), 'models'), (url, opts) => net.fetch(url, opts));
  models.on('progress', (state) => send('models', state));
  // If no model is chosen yet but one is on disk (for example after reinstalling), use it.
  if (!settings.get('model') || !models.isInstalled(settings.get('model'))) {
    const installed = models.installed();
    if (installed.length) settings.update({ model: installed[0] });
  }

  engine = new Engine({ app, logDir: app.getPath('logs') });
  engine.on('state', ({ state, error }) => {
    status.engine = state;
    status.engineError = error;
    pushStatus();
  });

  createTray();
  createPanel();
  createBadge();
  registerHotkey();
  startHelper();

  checker.setWords(allDictionaryWords());
  checker.load(settings.get('dialect'))
    .then(() => { status.checkerReady = true; pushStatus(); scheduleLint(0); })
    .catch((err) => { console.error('Harper failed to load', err); pushStatus(); });

  if (settings.get('launchAtLogin')) app.setLoginItemSettings({ openAtLogin: true });

  applyPauses();
  // Timers don't run while the Mac sleeps; check again when it wakes up.
  setInterval(() => {
    const ended = (settings.get('pausedApps') || []).some((p) => p.until <= Date.now())
      || (settings.get('pausedAllUntil') && settings.get('pausedAllUntil') <= Date.now());
    if (ended) applyPauses();
  }, 60 * 1000);

  if (!settings.get('welcomed')) {
    panel.webContents.once('did-finish-load', () => setTimeout(openWelcome, 300));
  }
}

function modelPath() {
  const id = settings.get('model');
  return id && models.isInstalled(id) ? models.pathFor(id) : null;
}

// ---------------------------------------------------------------------------------------------
// Menu bar

function trayImage(paused) {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', paused ? 'trayPausedTemplate.png' : 'trayTemplate.png'));
  icon.setTemplateImage(true);
  return icon;
}

function createTray() {
  tray = new Tray(trayImage(false));
  tray.setToolTip('Quill');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  const pausedApps = activePausedApps();
  const allUntil = pausedAllUntil();
  const anyPaused = settings.get('alwaysOn') && (allUntil > 0 || pausedApps.length > 0);
  tray.setImage(trayImage(anyPaused || !settings.get('alwaysOn')));
  tray.setToolTip(allUntil ? `Quill, paused ${untilLabel(allUntil)}`
    : pausedApps.length ? `Quill, paused in ${pausedApps.map((p) => p.name).join(', ')}`
      : settings.get('alwaysOn') ? 'Quill' : 'Quill, automatic checking off');

  const pauseItems = [];
  if (settings.get('alwaysOn')) {
    if (allUntil) {
      pauseItems.push({ label: `Paused everywhere ${untilLabel(allUntil)}`, enabled: false });
      pauseItems.push({ label: 'Resume everywhere', click: () => resumeAll() });
    } else {
      pauseItems.push({
        label: 'Pause everywhere',
        submenu: [
          { label: 'For 1 hour', click: () => pauseAll(Date.now() + HOUR) },
          { label: 'Until tomorrow morning', click: () => pauseAll(nextMorning()) },
        ],
      });
    }
    for (const p of pausedApps) {
      pauseItems.push({ label: `Resume in ${p.name} (paused ${untilLabel(p.until)})`, click: () => resumeApp(p.id) });
    }
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Check the text field I’m in', accelerator: settings.get('hotkey'), click: () => arm() },
    { label: 'Open scratchpad', click: () => startScratch({}) },
    { type: 'separator' },
    {
      label: 'Check automatically in every text field', type: 'checkbox', checked: !!settings.get('alwaysOn'),
      click: (item) => setAlwaysOn(item.checked),
    },
    ...pauseItems,
    { type: 'separator' },
    { label: 'Settings…', click: () => openSettings() },
    {
      label: 'Launch at login', type: 'checkbox', checked: !!settings.get('launchAtLogin'),
      click: (item) => { settings.update({ launchAtLogin: item.checked }); app.setLoginItemSettings({ openAtLogin: item.checked }); },
    },
    { label: 'Accessibility permission…', click: () => openAccessibilitySettings() },
    { type: 'separator' },
    { label: `Quill ${app.getVersion()}`, enabled: false },
    { label: 'Quit Quill', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  if (process.platform === 'darwin' && app.dock) {
    // The Dock icon's right-click menu: the same, minus Quit (the Dock adds its own).
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: 'Check the text field I’m in', click: () => arm() },
      { label: 'Open scratchpad', click: () => startScratch({}) },
      { type: 'separator' },
      { label: 'Check automatically in every text field', type: 'checkbox', checked: !!settings.get('alwaysOn'), click: (item) => setAlwaysOn(item.checked) },
      ...pauseItems,
      { type: 'separator' },
      { label: 'Settings…', click: () => openSettings() },
    ]));
  }
}

// ---------------------------------------------------------------------------------------------
// Pausing: automatic checking off for a while, in one app or everywhere. Pauses end on their own.

const HOUR = 60 * 60 * 1000;
let pauseTimer = null;

/** 06:00 tomorrow (or today, if it's still before 06:00). */
function nextMorning() {
  const d = new Date();
  d.setHours(6, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function untilLabel(until) {
  const d = new Date(until);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return `until ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `until tomorrow ${time}`;
  return `until ${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function activePausedApps() {
  const now = Date.now();
  return (settings.get('pausedApps') || []).filter((p) => p.until > now);
}

function pausedAllUntil() {
  const until = settings.get('pausedAllUntil') || 0;
  return until > Date.now() ? until : 0;
}

/** Automatic checking is on and not paused everywhere. */
function autoActive() {
  return !!settings.get('alwaysOn') && !pausedAllUntil();
}

function pauseApp(id, name, until) {
  if (!id) return;
  const list = (settings.get('pausedApps') || []).filter((p) => p.id !== id);
  settings.update({ pausedApps: [...list, { id, name, until }] });
  if (session.mode === 'watch' && session.bundleId === id) detach();
  applyPauses();
}

function resumeApp(id) {
  settings.update({ pausedApps: (settings.get('pausedApps') || []).filter((p) => p.id !== id) });
  applyPauses();
}

function pauseAll(until) {
  settings.update({ pausedAllUntil: until });
  if (session.mode === 'watch' && !session.panelOpen) detach();
  applyPauses();
}

function resumeAll() {
  settings.update({ pausedAllUntil: 0 });
  applyPauses();
}

/** Drop pauses that have ended, tell the helper what to skip, and wake up when the next one ends. */
function applyPauses() {
  const now = Date.now();
  const kept = (settings.get('pausedApps') || []).filter((p) => p.until > now);
  if (kept.length !== (settings.get('pausedApps') || []).length) settings.update({ pausedApps: kept });
  if (settings.get('pausedAllUntil') && settings.get('pausedAllUntil') <= now) settings.update({ pausedAllUntil: 0 });

  // Telling the helper makes it look at the current field again, so a resumed app picks up at once.
  if (ax) ax.config(excludedIds()).catch(() => {});
  refreshTrayMenu();
  updateBadge();
  send('settings-changed', settings.all());

  clearTimeout(pauseTimer);
  const ends = [...kept.map((p) => p.until), settings.get('pausedAllUntil') || 0].filter((t) => t > now);
  if (ends.length) {
    const wait = Math.min(Math.min(...ends) - now + 500, 2 ** 31 - 1);
    pauseTimer = setTimeout(applyPauses, wait);
  }
}

function applyDockVisibility() {
  if (process.platform !== 'darwin' || !app.dock) return;
  if (settings.get('showInDock')) app.dock.show().catch?.(() => {});
  else app.dock.hide();
}

/** The menus at the top of the screen while Quill is the active app. Edit makes ⌘C/⌘V work in the panel. */
function setApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Quill',
      submenu: [
        { role: 'about', label: 'About Quill' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => openSettings() },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Quill' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Quill' },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

// ---------------------------------------------------------------------------------------------
// Hotkey

function registerHotkey() {
  globalShortcut.unregisterAll();
  const accelerator = settings.get('hotkey');
  try {
    status.hotkeyOk = globalShortcut.register(accelerator, () => toggle());
  } catch (_) {
    status.hotkeyOk = false;
  }
  if (!status.hotkeyOk) console.warn(`Could not register hotkey ${accelerator}`);
  pushStatus();
}

// ---------------------------------------------------------------------------------------------
// Accessibility helper

function startHelper() {
  ax = new AXClient(helperPath(app));
  ax.on('status', (s) => {
    if (s.ok) {
      status.helper = 'ready';
      status.trusted = !!s.trusted;
      ax.config(excludedIds()).catch(() => {});
    } else {
      status.helper = s.reason === 'missing' ? 'missing' : 'failed';
      status.trusted = false;
      if (session.mode === 'watch') endSession();
    }
    pushStatus();
  });
  ax.on('event', onHelperEvent);
  ax.start();
}

function onHelperEvent(event) {
  switch (event.event) {
    case 'focus':
      onFocus(event);
      break;
    case 'value':
      if (session.mode !== 'watch' || event.handle !== session.handle) return;
      if (event.textSource && event.textSource !== session.textSource) {
        session.textSource = event.textSource;
        updateBadge();
      }
      textChanged(typeof event.value === 'string' ? event.value : '');
      break;
    case 'frame':
      if (session.mode !== 'watch' || event.handle !== session.handle) return;
      session.frame = event.frame || null;
      positionPanel();
      positionBadge();
      break;
    case 'lost':
      if (session.mode === 'watch' && event.handle === session.handle) detach();
      break;
    default:
      break;
  }
}

/** Apps the helper must not look into: excluded ones plus those paused right now. */
function excludedIds() {
  return [
    ...(settings.get('excludedApps') || []).map((a) => a.id),
    ...activePausedApps().map((p) => p.id),
  ];
}

/** A field Quill may attach to on its own. */
function eligible(info) {
  return info.found && info.editable && !info.secure && !info.search && !info.self
    && !excludedIds().includes(info.bundleId);
}

// The last focus changes, for "Copy diagnostics". Never includes any text.
const focusLog = [];
function logFocus(info, action) {
  focusLog.push({
    at: new Date().toISOString().slice(11, 19),
    app: info.app || '', bundleId: info.bundleId || '', role: info.role || '', subrole: info.subrole || '',
    found: !!info.found, editable: !!info.editable, secure: !!info.secure, search: !!info.search,
    frame: !!info.frame, reason: info.reason || '', action,
  });
  if (focusLog.length > 25) focusLog.shift();
}

/** Why a field isn't checked automatically, or null if it is (or should be). */
function autoReason(info) {
  if (!settings.get('alwaysOn')) return { code: 'off' };
  if (pausedAllUntil()) return { code: 'paused-all', label: untilLabel(pausedAllUntil()) };
  const paused = activePausedApps().find((p) => p.id === info.bundleId);
  if (paused) return { code: 'paused-app', app: paused.name, bundleId: paused.id, label: untilLabel(paused.until) };
  if ((settings.get('excludedApps') || []).some((a) => a.id === info.bundleId)) return { code: 'excluded', app: info.app || info.bundleId, bundleId: info.bundleId };
  if (info.search) return { code: 'search' };
  return null;
}

/** Keyboard focus moved somewhere, in any app. */
function onFocus(info) {
  if (info.self || info.reason === 'self') { logFocus(info, 'quill itself'); return; }
  if (session.mode === 'scratch') { logFocus(info, 'scratchpad open'); return; }

  if (autoActive()) {
    // Apps briefly report "nothing focused" while focus moves (switching apps or windows).
    // Within the attached app that's not a reason to let go; a real change follows.
    if (!info.found && info.reason === 'no-focused-element' && session.mode === 'watch' && info.pid === session.pid) {
      logFocus(info, 'no field (ignored, same app)');
      return;
    }
    if (eligible(info)) {
      if (session.mode === 'watch' && info.handle === session.handle) { logFocus(info, 'same field'); return; }
      logFocus(info, 'attach');
      attach(info);
      return;
    }
    logFocus(info, !info.found ? 'no field' : !info.editable ? 'not a text field' : info.secure ? 'password field'
      : info.search ? 'search field' : excludedIds().includes(info.bundleId) ? 'excluded or paused' : 'skipped');
    // Focus left the text field. If the panel is open and they're still in the same app,
    // keep it so they can finish what they were doing; otherwise let go.
    if (session.mode === 'watch' && !(session.panelOpen && info.pid === session.pid)) detach();
    return;
  }

  // Hotkey mode: only follow an open panel to another field in the same app.
  logFocus(info, settings.get('alwaysOn') ? 'paused everywhere' : 'automatic off');
  if (session.mode !== 'watch') return;
  if (info.pid !== session.pid) { detach(); return; }
  if (info.found && info.editable && !info.secure && info.handle !== session.handle) attach(info);
}

// ---------------------------------------------------------------------------------------------
// Sessions

async function toggle() {
  if (panel && panel.isVisible()) {
    closePanel();
    return;
  }
  if (session.mode === 'watch') {
    openPanel();
    return;
  }
  await arm();
}

/** Attach to whatever text field has keyboard focus right now and open the panel. */
async function arm() {
  if (status.helper !== 'ready') {
    startScratch({});
    return;
  }
  if (!status.trusted) {
    systemPreferences.isTrustedAccessibilityClient(true);
    try { status.trusted = await ax.isTrusted(); } catch (_) { /* ignore */ }
    pushStatus();
    if (!status.trusted) {
      startScratch({ needsPermission: true });
      return;
    }
  }
  let info;
  try {
    info = await ax.focus(true); // the hotkey is explicit, so it works in excluded apps too
  } catch (err) {
    console.warn('focus failed', err);
    startScratch({});
    return;
  }
  if (info.found && info.editable && !info.secure) {
    // Reaching here means the field wasn't already being checked. Say why, so it can be fixed.
    let reason = autoReason(info);
    if (!reason && autoActive()) reason = { code: 'missed', app: info.app || '' };
    logFocus(info, `hotkey${reason ? ' (' + reason.code + ')' : ''}`);
    await attach(info);
    openPanel();
    if (session.mode === 'watch' && session.textSource === 'none') send('auto-reason', { code: 'unreadable', app: info.app || '' });
    else if (reason && reason.code !== 'search') send('auto-reason', reason);
  } else {
    startScratch({ appName: info.app || '', noField: true });
  }
}

function resetText(text) {
  session.text = text;
  session.textSource = 'value';
  session.harperIssues = [];
  session.harperText = null;
  session.truncated = false;
  session.modelIssues = [];
  session.modelCheckedText = null;
  cancelModelCheck();
  cancelRewrite();
}

async function attach(info) {
  const keepPanel = session.mode === 'watch' && session.panelOpen && info.pid === session.pid;
  session.mode = 'watch';
  session.handle = info.handle;
  session.pid = info.pid;
  session.appName = info.app || '';
  session.bundleId = info.bundleId || '';
  session.frame = info.frame || null;
  session.panelOpen = keepPanel;
  resetText('');
  let watched = null;
  try { watched = await ax.watch(info.handle); } catch (err) { console.warn('watch failed', err); }
  if (session.handle !== info.handle) return; // focus moved again meanwhile
  if (!watched || !watched.ok) { detach(); return; }
  session.text = typeof watched.value === 'string' ? watched.value : '';
  session.textSource = watched.textSource || 'value';
  if (watched.frame) session.frame = watched.frame;
  logFocus(info, `watching: text via ${session.textSource}, ${session.text.length} characters read${watched.chars >= 0 ? `, field reports ${watched.chars}` : ''}`);
  pushSession();
  positionPanel();
  updateBadge();
  scheduleLint(0);
  scheduleModelCheck(MODEL_CHECK_DELAY_MS);
}

/** Stop watching the field and hide the badge and panel. */
function detach() {
  if (panel && panel.isVisible() && session.mode === 'watch') panel.hide();
  endSession();
}

function startScratch(opts = {}) {
  if (session.mode === 'watch') { ax.unwatch().catch(() => {}); }
  session.mode = 'scratch';
  session.handle = null;
  session.pid = null;
  session.appName = opts.appName || '';
  session.bundleId = '';
  session.frame = null;
  session.panelOpen = true;
  resetText('');
  updateBadge();
  pushSession({ needsPermission: !!opts.needsPermission, noField: !!opts.noField });
  positionPanelNearCursor();
  showPanel(true);
}

function endSession() {
  if (session.mode === 'watch') { ax.unwatch().catch(() => {}); }
  session.mode = 'none';
  session.handle = null;
  session.pid = null;
  session.bundleId = '';
  session.frame = null;
  session.panelOpen = false;
  resetText('');
  updateBadge();
  pushSession();
}

/** The text changed, either because the user typed or because Quill wrote to it. */
function textChanged(text) {
  if (text === session.text) return;
  session.modelIssues = rebase(session.text, text, session.modelIssues);
  session.text = text;
  pushLint(); // show the rebased model suggestions right away
  scheduleLint(200);
  scheduleModelCheck(MODEL_CHECK_DELAY_MS);
}

// ---------------------------------------------------------------------------------------------
// Instant checks (Harper)

function scheduleLint(delay) {
  clearTimeout(session.lintTimer);
  session.lintTimer = setTimeout(runLint, delay);
}

async function runLint() {
  if (!status.checkerReady || session.mode === 'none') return;
  const seq = ++session.lintSeq;
  const text = session.text;
  try {
    const result = await checker.check(text, { isolateEnglish: settings.get('isolateEnglish') });
    if (seq !== session.lintSeq || text !== session.text) return;
    session.harperIssues = result.issues;
    session.harperText = text;
    session.truncated = result.truncated;
    pushLint();
  } catch (err) {
    console.error('lint failed', err);
  }
}

// ---------------------------------------------------------------------------------------------
// Deeper checks (writing model, in the background when typing pauses)

function modelCheckEnabled() {
  return settings.get('autoCheck') && !!modelPath() && engine.available;
}

function cancelModelCheck() {
  clearTimeout(session.modelTimer);
  if (session.modelAbort) { session.modelAbort.abort(); session.modelAbort = null; }
  if (session.modelState !== 'error') session.modelState = 'idle';
}

function scheduleModelCheck(delay) {
  clearTimeout(session.modelTimer);
  if (session.modelAbort) { session.modelAbort.abort(); session.modelAbort = null; }
  if (session.mode === 'none' || !modelCheckEnabled()) return;
  const text = session.text;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words < 2 || text.length > MODEL_CHECK_MAX_CHARS || text === session.modelCheckedText) {
    if (session.modelState === 'waiting') { session.modelState = 'idle'; pushLint(); }
    return;
  }
  session.modelState = 'waiting';
  session.modelTimer = setTimeout(runModelCheck, delay);
}

async function runModelCheck() {
  if (session.rewriteAbort) { scheduleModelCheck(MODEL_CHECK_DELAY_MS); return; } // a rewrite is running
  const text = session.text;
  const controller = new AbortController();
  session.modelAbort = controller;
  try {
    if (engine.state !== 'ready') {
      session.modelState = 'starting';
      pushLint();
      await engine.ensure(modelPath());
    }
    if (controller.signal.aborted) return;
    session.modelState = 'checking';
    pushLint();
    const raw = await engine.chat({
      messages: prompts.messagesFor('fix', text, allDictionaryWords()),
      temperature: 0,
      maxTokens: prompts.maxTokensFor(text),
      signal: controller.signal,
    });
    if (controller.signal.aborted || text !== session.text) return;
    const corrected = prompts.clean(raw, text);
    session.modelIssues = suggestionsFromRewrite(text, corrected);
    session.modelCheckedText = text;
    session.modelState = 'idle';
    pushLint();
  } catch (err) {
    if (controller.signal.aborted) return;
    console.warn('model check failed', err);
    session.modelState = 'error';
    pushLint();
  } finally {
    if (session.modelAbort === controller) session.modelAbort = null;
  }
}

/** Harper's issues plus the model's, minus model suggestions that Harper already covers. */
function mergedIssues() {
  const harper = session.harperText === session.text ? session.harperIssues : [];
  const model = session.modelIssues
    .filter((m) => !harper.some((h) => overlaps(m, h)))
    .filter((m) => !changesDictionaryWord(m));
  return [...harper, ...model]
    .filter((issue) => !isIgnored(issue))
    .sort((a, b) => a.start - b.start)
    .map((issue, id) => ({ ...issue, id }));
}

// ---------------------------------------------------------------------------------------------
// Dictionary and ignored suggestions (stored in settings.json, on this Mac only)

// The team dictionary ships inside the app (team-dictionary.txt in the repository), so it only
// changes with a release. Each person can hide team words for themselves.
const TEAM = loadTeamDictionary();

function loadTeamDictionary() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'team-dictionary.txt'), 'utf8');
    const contact = (/^#\s*contact:\s*(\S+@\S+)/mi.exec(raw) || [])[1] || '';
    const seen = new Set();
    const words = [];
    for (const line of raw.split(/\r?\n/)) {
      const word = line.trim();
      if (!word || word.startsWith('#') || /\s/.test(word) || word.length > 60) continue;
      if (seen.has(word.toLowerCase())) continue;
      seen.add(word.toLowerCase());
      words.push(word);
    }
    return { words, contact };
  } catch (_) {
    return { words: [], contact: '' };
  }
}

function activeTeamWords() {
  const hidden = new Set((settings.get('hiddenTeamWords') || []).map((w) => w.toLowerCase()));
  return TEAM.words.filter((w) => !hidden.has(w.toLowerCase()));
}

/** Team words (minus the ones this person hid) plus their own. */
function allDictionaryWords() {
  const out = [];
  const seen = new Set();
  for (const w of [...activeTeamWords(), ...(settings.get('dictionary') || [])]) {
    if (seen.has(w.toLowerCase())) continue;
    seen.add(w.toLowerCase());
    out.push(w);
  }
  return out;
}

function isTeamWord(word) {
  return TEAM.words.some((w) => w.toLowerCase() === String(word).toLowerCase());
}

function hideTeamWord(word) {
  const list = settings.get('hiddenTeamWords') || [];
  if (isTeamWord(word) && !list.some((w) => w.toLowerCase() === word.toLowerCase())) {
    settings.update({ hiddenTeamWords: [...list, word] });
  }
  dictionaryChanged();
  return settings.all();
}

function showTeamWord(word) {
  settings.update({ hiddenTeamWords: (settings.get('hiddenTeamWords') || []).filter((w) => w.toLowerCase() !== word.toLowerCase()) });
  dictionaryChanged();
  return settings.all();
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}’'_-]*/gu;

function normalise(s) {
  return String(s || '').trim().toLowerCase();
}

/** A model suggestion that would change a word from the user's dictionary. */
function changesDictionaryWord(issue) {
  const dictionary = allDictionaryWords().map(normalise);
  if (!dictionary.length) return false;
  // Compare with the exact spelling, so "MID" → "mid" counts as a change too.
  const replacementWords = new Set(String(issue.suggestions[0]?.text || '').match(WORD_RE) || []);
  return (String(issue.problem || '').match(WORD_RE) || [])
    .some((w) => dictionary.includes(w.toLowerCase()) && !replacementWords.has(w));
}

function ignoreKey(issue) {
  return { problem: normalise(issue.problem), replacement: issue.suggestions[0] ? issue.suggestions[0].text.trim() : '' };
}

function isIgnored(issue) {
  const key = ignoreKey(issue);
  return (settings.get('ignoredSuggestions') || []).some((i) => i.problem === key.problem && i.replacement === key.replacement);
}

async function dictionaryChanged() {
  await checker.setWords(allDictionaryWords());
  session.harperText = null;
  pushLint();
  scheduleLint(0);
  send('settings-changed', settings.all());
}

function addToDictionary(word) {
  const clean = String(word || '').trim();
  if (!clean || clean.length > 60 || /\s/.test(clean)) return settings.all();
  if (isTeamWord(clean)) return showTeamWord(clean);
  const list = settings.get('dictionary') || [];
  if (!list.some((w) => w.toLowerCase() === clean.toLowerCase())) settings.update({ dictionary: [...list, clean].sort((a, b) => a.localeCompare(b)) });
  dictionaryChanged();
  return settings.all();
}

function removeFromDictionary(word) {
  settings.update({ dictionary: (settings.get('dictionary') || []).filter((w) => w !== word) });
  dictionaryChanged();
  return settings.all();
}

function ignoreAlways(issue) {
  const key = ignoreKey(issue);
  const list = settings.get('ignoredSuggestions') || [];
  if (!list.some((i) => i.problem === key.problem && i.replacement === key.replacement)) {
    settings.update({ ignoredSuggestions: [...list, key] });
  }
  pushLint();
  send('settings-changed', settings.all());
  return settings.all();
}

function unignore(key) {
  settings.update({
    ignoredSuggestions: (settings.get('ignoredSuggestions') || []).filter((i) => !(i.problem === key.problem && i.replacement === key.replacement)),
  });
  pushLint();
  return settings.all();
}

function pushLint() {
  updateBadge();
  send('lint', {
    text: session.text,
    issues: mergedIssues(),
    truncated: session.truncated,
    harperReady: session.harperText === session.text,
    model: {
      enabled: modelCheckEnabled(),
      state: session.modelState,
      checked: session.modelCheckedText === session.text,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Writing text back

async function writeText(text, caret) {
  if (session.mode === 'scratch') {
    send('scratch-set', { text, caret });
    textChanged(text);
    return { ok: true, method: 'scratch' };
  }
  if (session.mode !== 'watch') return { ok: false, error: 'no-session' };

  try {
    const result = await ax.setText(session.handle, text, caret);
    if (result.ok) { textChanged(text); return result; }
  } catch (err) {
    console.warn('setText failed', err);
  }

  // Fallback: select all and paste through the clipboard. Cruder, but works everywhere.
  const previous = clipboard.readText();
  clipboard.writeText(text);
  try {
    await ax.activate(session.pid);
    await sleep(180);
    await ax.keys(session.pid, [['cmd', 'a'], ['cmd', 'v']]);
    await sleep(450);
  } catch (err) {
    clipboard.writeText(previous);
    return { ok: false, error: String(err) };
  }
  setTimeout(() => { if (clipboard.readText() === text) clipboard.writeText(previous); }, 1200);
  textChanged(text);
  return { ok: true, method: 'paste' };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------------------------
// Rewrites

function cancelRewrite() {
  if (session.rewriteAbort) { session.rewriteAbort.abort(); session.rewriteAbort = null; }
}

async function doRewrite(mode) {
  cancelRewrite();
  const text = session.text;
  if (!text.trim()) return { ok: false, error: { code: 'empty', message: 'Nothing to rewrite yet.' } };
  const file = modelPath();
  if (!file) return { ok: false, error: { code: 'no-model', message: 'The writing model isn’t downloaded yet.' } };
  // A rewrite takes priority over a background check.
  clearTimeout(session.modelTimer);
  if (session.modelAbort) { session.modelAbort.abort(); session.modelAbort = null; }
  const controller = new AbortController();
  session.rewriteAbort = controller;
  try {
    await engine.ensure(file);
    if (controller.signal.aborted) throw new Error('cancelled');
    const raw = await engine.chat({
      messages: prompts.messagesFor(mode, text, allDictionaryWords()),
      temperature: mode === 'fix' ? 0 : 0.3,
      maxTokens: prompts.maxTokensFor(text),
      signal: controller.signal,
    });
    const model = CATALOG[settings.get('model')];
    return { ok: true, mode, text: prompts.clean(raw, text), original: text, modelLabel: model ? model.label : '' };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'Cancelled.' } };
    return { ok: false, error: { code: 'error', message: err.message || String(err) } };
  } finally {
    if (session.rewriteAbort === controller) session.rewriteAbort = null;
    scheduleModelCheck(MODEL_CHECK_DELAY_MS);
  }
}

// ---------------------------------------------------------------------------------------------
// Panel window

function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 220,
    show: false,
    frame: false,
    roundedCorners: true,
    hasShadow: true,
    backgroundColor: panelBackground(),
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    type: 'panel',
    hiddenInMissionControl: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  panel.setAlwaysOnTop(true, 'floating');
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.setMenuBarVisibility(false);
  panel.loadFile(path.join(__dirname, 'src', 'panel.html'));
  panel.on('close', (e) => { if (quitting) return; e.preventDefault(); closePanel(); });
  nativeTheme.on('updated', () => { if (panel && !panel.isDestroyed()) panel.setBackgroundColor(panelBackground()); });
  panel.webContents.on('did-finish-load', () => { pushStatus(); pushSession(); });
  // The panel never navigates or opens windows.
  panel.webContents.on('will-navigate', (e) => e.preventDefault());
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function panelBackground() {
  return nativeTheme.shouldUseDarkColors ? '#1F2124' : '#F6F5F1';
}

function showPanel(takeFocus) {
  if (!panel) return;
  if (takeFocus) panel.show(); else panel.showInactive();
}

function openPanel() {
  if (session.mode === 'none') return;
  session.panelOpen = true;
  positionPanel();
  showPanel(session.mode === 'scratch');
  updateBadge();
}

/** Close the panel. In automatic mode the field stays attached and the badge comes back. */
function closePanel() {
  if (panel && panel.isVisible()) panel.hide();
  if (session.mode === 'watch' && autoActive()) {
    session.panelOpen = false;
    cancelRewrite();
    updateBadge();
    send('rewrite-reset');
    return;
  }
  endSession();
}

// ---------------------------------------------------------------------------------------------
// Badge: a small circle at the corner of the field, showing a checkmark or the number of issues

function createBadge() {
  badgeWin = new BrowserWindow({
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    type: 'panel',
    hiddenInMissionControl: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-badge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  badgeWin.setAlwaysOnTop(true, 'floating');
  badgeWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  badgeWin.loadFile(path.join(__dirname, 'src', 'badge.html'));
  badgeWin.webContents.on('will-navigate', (e) => e.preventDefault());
  badgeWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  badgeWin.webContents.on('did-finish-load', () => updateBadge());
}

function badgeShouldShow() {
  // No badge where Quill can't read the text: it would only sit there doing nothing.
  return settings && autoActive() && session.mode === 'watch' && !session.panelOpen && !!session.frame
    && session.textSource !== 'none';
}

function updateBadge() {
  if (!badgeWin || badgeWin.isDestroyed()) return;
  if (!badgeShouldShow()) {
    if (badgeWin.isVisible()) badgeWin.hide();
    return;
  }
  const issues = mergedIssues();
  const hasText = !!session.text.trim();
  const busy = hasText && (session.harperText !== session.text
    || session.modelState === 'starting' || session.modelState === 'checking');
  let kind = 'idle';
  if (hasText && issues.length > 0) kind = 'issues';
  else if (hasText && session.harperText === session.text) kind = 'ok';
  badgeWin.webContents.send('badge-state', { kind, count: issues.length, busy, app: session.appName });
  positionBadge();
  if (!badgeWin.isVisible()) badgeWin.showInactive();
}

/** Bottom-right corner of the field, inside it; to the right of very short fields. */
function positionBadge() {
  if (!badgeWin || badgeWin.isDestroyed() || !session.frame) return;
  const f = session.frame;
  const rect = { x: Math.round(f.x), y: Math.round(f.y), width: Math.max(1, Math.round(f.w)), height: Math.max(1, Math.round(f.h)) };
  const area = screen.getDisplayMatching(rect).workArea;
  let x; let y;
  if (rect.height >= 40) {
    x = rect.x + rect.width - BADGE_SIZE - 2;
    y = rect.y + rect.height - BADGE_SIZE - 2;
  } else {
    x = rect.x + rect.width - BADGE_SIZE + 2;
    y = rect.y + Math.round((rect.height - BADGE_SIZE) / 2);
  }
  x = clamp(x, area.x, area.x + area.width - BADGE_SIZE);
  y = clamp(y, area.y, area.y + area.height - BADGE_SIZE);
  badgeWin.setPosition(x, y, false);
}

function excludeCurrentApp() {
  if (!session.bundleId) return;
  const list = settings.get('excludedApps') || [];
  if (!list.some((a) => a.id === session.bundleId)) {
    settings.update({ excludedApps: [...list, { id: session.bundleId, name: session.appName || session.bundleId }] });
  }
  ax.config(excludedIds()).catch(() => {});
  detach();
  send('settings-changed', settings.all());
}

function setAlwaysOn(on) {
  settings.update({ alwaysOn: on });
  if (!on && session.mode === 'watch' && !session.panelOpen) detach();
  updateBadge();
  refreshTrayMenu();
  send('settings-changed', settings.all());
}

function positionPanel() {
  if (!panel || session.mode !== 'watch' || !session.frame) return;
  const f = session.frame;
  const rect = { x: Math.round(f.x), y: Math.round(f.y), width: Math.max(1, Math.round(f.w)), height: Math.max(1, Math.round(f.h)) };
  const area = screen.getDisplayMatching(rect).workArea;
  const [w, h] = panel.getSize();

  let x; let y;
  if (rect.x + rect.width + GAP + w <= area.x + area.width) {
    x = rect.x + rect.width + GAP;
    y = rect.y;
  } else if (rect.x - GAP - w >= area.x) {
    x = rect.x - GAP - w;
    y = rect.y;
  } else if (rect.y - GAP - h >= area.y) {
    x = rect.x + rect.width - w;
    y = rect.y - GAP - h;
  } else {
    x = rect.x + rect.width - w;
    y = rect.y + rect.height + GAP;
  }
  x = clamp(x, area.x, area.x + area.width - w);
  y = clamp(y, area.y, area.y + area.height - h);
  panel.setPosition(x, y, false);
}

function positionPanelNearCursor() {
  if (!panel) return;
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const [w, h] = panel.getSize();
  panel.setPosition(clamp(cursor.x + 16, area.x, area.x + area.width - w), clamp(cursor.y + 16, area.y, area.y + area.height - h), false);
}

function positionPanelTopRight() {
  if (!panel) return;
  const area = screen.getPrimaryDisplay().workArea;
  const [w] = panel.getSize();
  panel.setPosition(area.x + area.width - w - 24, area.y + 12, false);
}

function resizePanel(height) {
  if (!panel) return;
  const h = clamp(Math.ceil(height), PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT);
  const [w, current] = panel.getSize();
  if (current === h) return;
  const [x, y] = panel.getPosition();
  panel.setBounds({ x, y, width: w, height: h }, false);
  const area = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
  if (y + h > area.y + area.height) panel.setPosition(x, Math.max(area.y, area.y + area.height - h), false);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------------------------------------------------------------------------------------------
// Talking to the panel

function send(channel, payload) {
  if (panel && !panel.isDestroyed()) panel.webContents.send(channel, payload);
}

function pushStatus() {
  send('status', { ...status, hotkey: settings ? settings.get('hotkey') : '', model: settings ? settings.get('model') : null });
}

function pushSession(extra = {}) {
  send('session', { mode: session.mode, appName: session.appName, text: session.text, ...extra });
}

function openSettings() {
  if (session.mode === 'none') positionPanelNearCursor();
  if (session.mode === 'watch') { session.panelOpen = true; updateBadge(); }
  showPanel(true);
  send('open-view', 'settings');
}

function openWelcome() {
  positionPanelTopRight();
  showPanel(true);
  send('open-view', 'welcome');
}

function openAccessibilitySettings() {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
}

ipcMain.handle('ready', () => ({
  status: { ...status, hotkey: settings.get('hotkey'), model: settings.get('model') },
  settings: settings.all(),
  session: { mode: session.mode, appName: session.appName, text: session.text },
  modes: Object.fromEntries(Object.entries(prompts.MODES).map(([k, v]) => [k, { label: v.label, hint: v.hint }])),
  models: models.state(),
  version: app.getVersion(),
}));

ipcMain.handle('scratch-text', (_e, text) => {
  if (session.mode !== 'scratch') return;
  textChanged(String(text ?? ''));
});

ipcMain.handle('apply-fix', async (_e, { issue, suggestion }) => {
  const { text, caret } = applySuggestion(session.text, issue, suggestion);
  return writeText(text, caret);
});

ipcMain.handle('fix-all', async () => {
  // Apply the first suggestion of every issue, last to first so earlier positions stay valid.
  let text = session.text;
  const fixable = mergedIssues().filter((i) => i.suggestions.length > 0).sort((a, b) => b.start - a.start);
  if (fixable.length === 0) return { ok: false, error: 'nothing-to-fix' };
  let limit = Infinity;
  for (const issue of fixable) {
    if (issue.end > limit) continue; // overlaps one already applied
    text = applySuggestion(text, issue, issue.suggestions[0]).text;
    limit = issue.start;
  }
  return writeText(text);
});

ipcMain.handle('rewrite', (_e, mode) => doRewrite(mode));
ipcMain.handle('cancel-rewrite', () => { cancelRewrite(); return true; });
ipcMain.handle('replace', (_e, text) => writeText(String(text ?? '')));
ipcMain.handle('copy', (_e, text) => { clipboard.writeText(String(text ?? '')); return true; });
ipcMain.handle('resize', (_e, height) => { resizePanel(height); });
ipcMain.handle('close', () => { closePanel(); });
ipcMain.handle('badge-click', () => { openPanel(); });
ipcMain.handle('badge-menu', () => {
  const name = session.appName || 'this app';
  const menu = Menu.buildFromTemplate([
    { label: 'Open Quill', click: () => openPanel() },
    { type: 'separator' },
    { label: `Pause in ${name} for 1 hour`, enabled: !!session.bundleId, click: () => pauseApp(session.bundleId, name, Date.now() + HOUR) },
    { label: `Pause in ${name} until tomorrow morning`, enabled: !!session.bundleId, click: () => pauseApp(session.bundleId, name, nextMorning()) },
    { label: 'Pause everywhere for 1 hour', click: () => pauseAll(Date.now() + HOUR) },
    { type: 'separator' },
    { label: `Don’t check in ${name}`, enabled: !!session.bundleId, click: () => excludeCurrentApp() },
    { label: 'Turn off automatic checking', click: () => setAlwaysOn(false) },
  ]);
  menu.popup({ window: badgeWin });
});
ipcMain.handle('auto-fix', (_e, reason) => {
  if (!reason) return null;
  if (reason.code === 'off') setAlwaysOn(true);
  else if (reason.code === 'paused-all') resumeAll();
  else if (reason.code === 'paused-app') resumeApp(reason.bundleId);
  else if (reason.code === 'excluded') {
    settings.update({ excludedApps: (settings.get('excludedApps') || []).filter((a) => a.id !== reason.bundleId) });
    ax.config(excludedIds()).catch(() => {});
    send('settings-changed', settings.all());
  }
  updateBadge();
  return settings.all();
});
ipcMain.handle('open-scratch', () => { startScratch({}); });
ipcMain.handle('diagnostics', () => {
  const s = settings.all();
  const report = {
    quill: app.getVersion(),
    macOS: os.release(), arch: process.arch, memoryGB: Math.round(os.totalmem() / 1024 ** 3),
    packaged: app.isPackaged,
    helper: status.helper, trusted: status.trusted, hotkeyOk: status.hotkeyOk, engine: status.engine,
    alwaysOn: s.alwaysOn, autoActive: autoActive(), showInDock: s.showInDock,
    pausedEverywhereUntil: pausedAllUntil() ? new Date(pausedAllUntil()).toISOString() : null,
    pausedApps: activePausedApps().map((p) => p.id),
    excludedApps: (s.excludedApps || []).map((a) => a.id),
    model: s.model, autoCheck: s.autoCheck,
    teamWords: TEAM.words.length, hiddenTeamWords: (s.hiddenTeamWords || []).length, ownWords: (s.dictionary || []).length,
    session: { mode: session.mode, app: session.appName, panelOpen: session.panelOpen, hasFrame: !!session.frame, textSource: session.textSource, textLength: session.text.length, badgeVisible: !!(badgeWin && badgeWin.isVisible()) },
    recentFocus: focusLog,
  };
  return JSON.stringify(report, null, 2);
});
ipcMain.handle('team:state', () => ({
  words: TEAM.words,
  hidden: settings.get('hiddenTeamWords') || [],
  contact: TEAM.contact,
}));
ipcMain.handle('team:hide', (_e, word) => hideTeamWord(String(word || '')));
ipcMain.handle('team:show', (_e, word) => showTeamWord(String(word || '')));
// Opens a draft email to the team dictionary's maintainer with the words to suggest. Nothing
// is sent by Quill; the person reviews and sends it from their own mail app.
ipcMain.handle('team:suggest', (_e, words) => {
  if (!TEAM.contact) return false;
  const list = (Array.isArray(words) ? words : []).filter((w) => !isTeamWord(w)).slice(0, 100);
  const subject = 'Quill team dictionary: words to add';
  const body = `Hi,\n\nPlease consider adding these words to Quill's team dictionary:\n\n${list.map((w) => `  ${w}`).join('\n')}\n\nThanks!`;
  shell.openExternal(`mailto:${TEAM.contact}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
  return true;
});
ipcMain.handle('dict:add', (_e, word) => addToDictionary(word));
ipcMain.handle('dict:remove', (_e, word) => removeFromDictionary(word));
ipcMain.handle('ignore:add', (_e, issue) => ignoreAlways(issue));
ipcMain.handle('ignore:remove', (_e, key) => unignore(key));
ipcMain.handle('pause:resume-app', (_e, id) => { resumeApp(id); return settings.all(); });
ipcMain.handle('pause:resume-all', () => { resumeAll(); return settings.all(); });
ipcMain.handle('pause:labels', () => ({
  all: pausedAllUntil() ? untilLabel(pausedAllUntil()) : null,
  apps: activePausedApps().map((p) => ({ id: p.id, name: p.name, label: untilLabel(p.until) })),
}));
ipcMain.handle('excluded:remove', (_e, id) => {
  settings.update({ excludedApps: (settings.get('excludedApps') || []).filter((a) => a.id !== id) });
  ax.config(excludedIds()).catch(() => {});
  return settings.all();
});
ipcMain.handle('retry-focus', () => arm());

ipcMain.handle('settings:get', () => settings.all());
ipcMain.handle('settings:set', async (_e, patch) => {
  const before = settings.all();
  const after = settings.update(patch);
  if (before.hotkey !== after.hotkey) { registerHotkey(); refreshTrayMenu(); }
  if (before.dialect !== after.dialect) {
    status.checkerReady = false; pushStatus();
    checker.load(after.dialect).then(() => { status.checkerReady = true; pushStatus(); scheduleLint(0); });
  }
  if (before.isolateEnglish !== after.isolateEnglish) scheduleLint(0);
  if (before.launchAtLogin !== after.launchAtLogin) { app.setLoginItemSettings({ openAtLogin: after.launchAtLogin }); refreshTrayMenu(); }
  if (before.showInDock !== after.showInDock) applyDockVisibility();
  if (before.alwaysOn !== after.alwaysOn) {
    if (!after.alwaysOn && session.mode === 'watch' && !session.panelOpen) detach();
    updateBadge(); refreshTrayMenu();
  }
  if (before.autoCheck !== after.autoCheck) {
    if (!after.autoCheck) { cancelModelCheck(); session.modelIssues = []; pushLint(); } else scheduleModelCheck(0);
  }
  if (before.model !== after.model) {
    await engine.stop();
    session.modelIssues = []; session.modelCheckedText = null;
    pushStatus(); pushLint(); scheduleModelCheck(0);
  }
  return after;
});

ipcMain.handle('models:state', () => models.state());
ipcMain.handle('models:download', async (_e, id) => {
  if (!CATALOG[id]) return { ok: false, error: 'unknown model' };
  settings.update({ welcomed: true });
  try {
    await models.fetchModel(id);
    settings.update({ model: id });
    await engine.stop();
    session.modelIssues = []; session.modelCheckedText = null;
    pushStatus(); pushLint(); scheduleModelCheck(0);
    send('models', models.state());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});
ipcMain.handle('models:cancel', () => { models.cancel(); return true; });
ipcMain.handle('models:remove', async (_e, id) => {
  if (!CATALOG[id]) return models.state();
  if (settings.get('model') === id) {
    await engine.stop();
    const other = models.installed().find((m) => m !== id) || null;
    settings.update({ model: other });
    session.modelIssues = []; pushLint(); pushStatus();
  }
  models.remove(id);
  return models.state();
});
ipcMain.handle('models:reveal', () => { shell.openPath(path.join(app.getPath('userData'), 'models')); });
ipcMain.handle('welcome-done', () => { settings.update({ welcomed: true }); return true; });
ipcMain.handle('open-accessibility', () => openAccessibilitySettings());
ipcMain.handle('open-url', (_e, url) => {
  if (/^https:\/\/(huggingface\.co|github\.com|writewithharper\.com)\//.test(url)) shell.openExternal(url);
});
