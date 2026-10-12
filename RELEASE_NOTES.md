### New
- **Quill updates itself.** Choose **Check for Updates…** in the menu bar menu, the Dock menu or the Quill menu. When there's a newer version, click **Install and restart**: Quill downloads it, installs it in Applications and restarts. No dmg, no dragging, and no "could not verify" warning.
- **Updates are checked before they're installed.** Quill only installs a version signed with the Quill certificate, the same one this version is signed with. Anything else is refused.
- **Daily check.** Once a day Quill asks GitHub whether there's a newer version, and tells you with a notification and an **Update to Quill …** item in the menu bar menu. It sends nothing but that question. You can switch it off in Settings.

### Updating to this version
This is the last time you update by hand; from now on Quill does it. Request Administrator Mode in the PaymentIQ Self Service app, quit Quill, open the dmg below, drag Quill to Applications and choose **Replace**, then open it.

If macOS says *"Apple could not verify 'Quill' is free of malware…"*, click **Done** (not Move to Bin), run this in Terminal, and open Quill again:

```
xattr -dr com.apple.quarantine /Applications/Quill.app
```
