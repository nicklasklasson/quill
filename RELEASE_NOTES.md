### Improved
- **The install guide now starts with what to do first:** request **Administrator Mode** in the PaymentIQ Self Service app before installing or updating Quill.
- **The guide shows how to get past macOS's "could not verify" warning** with one Terminal line, which works on company Macs where the Open Anyway button doesn't appear.
- `release.sh` now confirms each release is signed with the Quill signing certificate.

### Updating
Request Administrator Mode in the PaymentIQ Self Service app. Quit Quill (menu bar menu › Quit Quill), open the dmg below, drag Quill to Applications and choose **Replace**, then open it.

If macOS says *"Apple could not verify 'Quill' is free of malware…"*, click **Done** (not Move to Bin), run this in Terminal, and open Quill again:

```
xattr -dr com.apple.quarantine /Applications/Quill.app
```

Coming from 0.1.10, Quill should keep its Accessibility permission: the badge appears right away, with nothing to switch on. If Quill says it needs the permission, click **Reset permission** in its panel and switch it on again.
