### Fixed
- **The badge works in the installed app.** A file the badge needs was left out of the app, so the badge only ever showed the feather and didn't react to clicks. It now shows the checkmark or the number of things to fix, and opens the panel with one click. (Checking itself was working; only the badge was affected.)
- The build now checks that the app contains every file it needs before publishing, so a missing file can't slip through again.

### Updating
Quit Quill (menu bar menu › Quit Quill), open the dmg below, drag Quill to Applications and choose **Replace**. Your settings, dictionary and models are kept. If Quill keeps asking for Accessibility afterwards, run `tccutil reset Accessibility app.quill.writing` in Terminal and allow Quill again.
