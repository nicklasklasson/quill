### Fixed
- **Checking in rich-text editors.** Some apps, such as the Claude desktop app, keep the text of their message box in a way Quill didn't read, so the badge appeared but never checked anything. Quill now reads the text in two more ways, and works in those fields.
- **No more empty badges.** If an app really doesn't let Quill read a field, Quill shows no badge there instead of one that does nothing. Pressing ⌥⌘G in such a field explains it and offers the scratchpad.
- **Steadier badge.** Apps briefly report "nothing focused" while you switch windows or tabs; Quill no longer lets go of the field when that happens, so the badge doesn't flicker or disappear.

### Updating
Quit Quill (menu bar menu › Quit Quill), open the dmg below, drag Quill to Applications and choose **Replace**. Your settings, dictionary and models are kept. If Quill keeps asking for Accessibility afterwards, run `tccutil reset Accessibility app.quill.writing` in Terminal and allow Quill again.
