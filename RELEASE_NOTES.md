### New
- **Ignore, just here.** Every suggestion now has **Ignore** next to **Always ignore**. It hides that one suggestion in that spot, for when Quill wants to change something that was fine. It comes back if you edit that word or leave the field. Nothing is saved.
- **Fewer unnecessary changes.** The writing model is now told not to change verb tenses or word choice that are already correct (such as "it worked better" → "it works better").

### Fixed
- **Check for Updates works.** In 0.1.12 it could say "Unexpected answer from GitHub (200)". Quill now reads the newest version from GitHub's release page, with GitHub's API as a fallback.

### Updating to this version
Because of that bug, 0.1.12 can't update itself to this version, so this is the last update by hand. Request Administrator Mode in the PaymentIQ Self Service app, quit Quill, open the dmg below, drag Quill to Applications and choose **Replace**, then open it.

If macOS says *"Apple could not verify 'Quill' is free of malware…"*, click **Done** (not Move to Bin), run this in Terminal, and open Quill again:

```
xattr -dr com.apple.quarantine /Applications/Quill.app
```

From this version on, **Check for Updates…** in the menu bar menu installs new versions for you.
