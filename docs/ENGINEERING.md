# Quill: engineering notes

How Quill is built, signed, released and updated, what went wrong along the way, and how to bring
the same setup to other apps (Loupe first). Written so a future session can pick this up cold.

Repository: https://github.com/nicklasklasson/quill (public). Raw version of this file:
https://raw.githubusercontent.com/nicklasklasson/quill/main/docs/ENGINEERING.md

## Architecture in one paragraph

Electron app, menu bar + Dock. `native/QuillAX.swift` is a small helper process that uses the macOS
Accessibility API: it follows keyboard focus in every app (never reading text) and, for the one field
Quill attaches to, reads and writes its text. Spelling and grammar come from Harper (WebAssembly,
in-process). Deeper checks and rewrites come from a local model run by a bundled llama.cpp
`llama-server` (127.0.0.1, random port, random API key, `--offline`, stopped after 10 idle minutes).
Models (Gemma 4 12B, Qwen2.5 7B, Qwen3 4B) are downloaded once from Hugging Face, pinned to a
repository revision and checked against a SHA-256. A badge window sits in the corner of the focused
field; the panel window shows suggestions and rewrites.

## Release pipeline

- **Nobody builds locally.** `./release.sh` commits, pushes, tags `v<version from package.json>`, waits
  for GitHub Actions, prints whether the build was signed with the Quill certificate, downloads the
  dmg and opens it. Re-running it for an unreleased version moves the tag and rebuilds.
- **New version folder from a zip** (no `.git` inside): `git init -b main`, `git remote add origin
  https://github.com/nicklasklasson/quill.git`, `git fetch origin`, `git reset origin/main`, then
  `./release.sh`. `git reset` (mixed) keeps the new files and makes git diff them against main.
- **Workflow** `.github/workflows/release.yml` on `macos-latest`: Node 22, `npm install` (postinstall
  runs `build/postinstall.js`: unpack Electron, compile the Swift helper universal, fetch the pinned
  llama.cpp engine), load the signing certificate, `npm run dist:mac -- --publish never`, run
  `build/check-packaged.js`, publish the release with `RELEASE_NOTES.md` as notes and `docs/*.pdf`
  attached (`file#Display name` so GitHub doesn't turn spaces into dots).
- **`build/check-packaged.js`** reads `main.js` (and what it requires and loads) and fails the build if
  any file is missing from the packaged app. Added after `preload-badge.js` was left out of `files`
  in package.json: the badge rendered but never updated or reacted to clicks, and only in the
  installed app. Paths with an extension (like `./package.json`) are taken as written.

## Signing (keeps the Accessibility permission across updates)

macOS remembers Accessibility (TCC) permission by the app's *designated requirement*. An ad-hoc
signature is a hash of the build, so every update looked like a new app and the permission had to be
granted again (`tccutil reset Accessibility app.quill.writing`). Fix: sign every build with the same
self-signed certificate.

- `build/make-signing-cert.sh` (run once): creates "Quill Signing" (RSA 2048, 20 years, EKU
  codeSigning) with `/usr/bin/openssl`, exports a `.p12` with a random password, stores both as repo
  secrets `QUILL_SIGNING_P12` (base64) and `QUILL_SIGNING_PASSWORD`, and keeps a backup in
  `~/Documents/Quill signing certificate` (move it to 1Password). `--upload` re-uploads the backup.
  GitHub secrets can't be read back, so the backup is the only copy.
- Workflow step "Load the Quill signing certificate": temporary keychain, `security import`,
  `set-key-partition-list`, trust the cert on the runner only (`sudo security add-trusted-cert -p
  codeSign`), export `QUILL_SIGN_IDENTITY` (SHA-1) and `QUILL_KEYCHAIN`.
- `build/adhoc-sign.js` (electron-builder `afterPack`, because `afterSign` is skipped without a
  Developer ID): signs every Mach-O in `Contents/Resources` (helper, llama.cpp dylibs and server)
  first, then the app with `--deep`, verifies, and logs the designated requirement. Falls back to
  ad hoc when the secrets aren't there. Skips the `-temp` halves of the universal build.
- Expected log line: `designated => identifier "app.quill.writing" and certificate leaf = H"af22f7…"`.
  Confirmed in practice: the permission survived the 0.1.10 → 0.1.11 update.
- What it doesn't fix: Gatekeeper. Browser downloads are quarantined and macOS says *"Apple could not
  verify 'Quill' is free of malware…"* (Done / Move to Bin). On PaymentIQ Macs the Open Anyway button
  often doesn't appear; `xattr -dr com.apple.quarantine /Applications/Quill.app` works (needs
  Administrator Mode from the PaymentIQ Self Service app). Only a paid Apple Developer ID with
  notarization removes the warning. Files downloaded by `gh` or by the app itself aren't quarantined.

## Self-update (`src/updater.js`)

- **Check:** GET `https://github.com/<repo>/releases/latest` and read the tag from the final URL, or
  else from the page HTML (Electron's `net.fetch` doesn't expose the URL after a redirect; that broke
  0.1.12), or else from `api.github.com/repos/<repo>/releases/latest` (rate-limited, last resort).
  Daily automatic check (setting `autoUpdateCheck`), one notification per new version, plus an
  "Update to Quill …" menu item.
- **Install:** refuse if running from source or from `/Volumes`, and check `/Applications` is
  writable first (needs Administrator Mode; show "Try again" instead of failing halfway). Download
  the dmg with `net.fetch` (respects system proxy), `hdiutil attach -nobrowse -readonly`, then
  `codesign --verify --deep --strict -R=<designated requirement of the running app>` on the new app:
  only an app signed with the same certificate is installed. Check its version is newer, `ditto` it
  to `/Applications/.Quill-update.app`, write a small swap script, spawn it detached, quit. The script
  waits for the PID to exit, moves the old app aside, moves the new one in, restores the old one if
  anything fails, and opens the app.
- After a restart into a new version, `announceUpdate()` shows "Quill updated to X" once.
- The repo comes from `repository.url` in package.json.

## Gotchas we hit (worth remembering)

- `gh run view` needs a run ID when not interactive: use
  `gh run view $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId') --log`.
- zsh expands `!` inside double quotes ("event not found"): use single quotes for commands with `!`.
- electron-builder publishes by itself when it sees a tag in CI and fails without `GH_TOKEN`: always
  `--publish never` and publish in a separate step.
- Newer npm blocks Electron's install script, and on Node 26 Electron's unzip silently fails:
  `build/ensure-electron.js` unpacks the cached zip with `ditto`.
- Universal builds: identical Mach-O files in both halves need `"x64ArchFiles": "Contents/Resources/bin/**"`.
- Panel `close` handler that only hides the window blocked Quit: track `before-quit` and let it close.
- `type: 'panel'` windows plus `focusable: false` for the badge, so clicks don't steal focus.
- Chromium/Electron apps (Slack, Claude, Chrome) need `AXManualAccessibility = true` to expose their
  accessibility tree, and briefly report "no focused element" while focus moves: ignore that blip
  within the same app.
- Rich-text editors may not expose text as `AXValue`; the helper falls back to
  `AXNumberOfCharacters` + `AXStringForRange`, then to collecting child `AXStaticText`.
- Running from Terminal (`npm start`) uses Terminal's Accessibility permission, not the app's.
- Harper splits words at digits ("3DS" → "3", "DS"): dictionary words with digits also add their
  letter parts.
- The app's settings are shared between the dev build and the installed one
  (`~/Library/Application Support/Quill`), including old pauses and exclusions.

## Porting signing and updates to Loupe (checklist)

Loupe (https://github.com/nicklasklasson/loupe) is an Electron screen capture/annotation app with a
native module (`uiohook-napi`) and its own Accessibility/Screen Recording needs. As of Quill 0.1.14 it
was built locally with `npm run dist:mac` and published with `gh release`.

1. **Move Loupe's builds to GitHub Actions** like Quill: copy `.github/workflows/release.yml` and
   `release.sh`; adapt the install step (no Swift helper or llama.cpp), keep `--publish never`, keep
   `x64ArchFiles` for `uiohook-napi` prebuilds (Loupe already had a rule for that).
2. **Certificate:** copy `build/make-signing-cert.sh`, rename to "Loupe Signing", secrets
   `LOUPE_SIGNING_P12` / `LOUPE_SIGNING_PASSWORD`, backup folder `~/Documents/Loupe signing
   certificate`. A separate certificate per app keeps them independent.
3. **Signing hook:** Loupe's `build/adhoc-sign.js` already signs ad hoc; replace with Quill's version
   (env `QUILL_SIGN_IDENTITY`/`QUILL_KEYCHAIN` → rename), make sure it signs the `.node` native
   module files before the app, and keep the designated-requirement log line.
4. **Permission:** first signed version needs Screen Recording / Accessibility once more; after that
   it should stick. Verify with two consecutive releases.
5. **Updater:** copy `src/updater.js` unchanged (it's generic: repo from package.json, bundle name
   `Quill.app` and `.Quill-update.app` need renaming to `Loupe.app`), add `repository.url`, the
   menu items, the update view, `announceUpdate()`, and the `autoUpdateCheck` setting.
6. **Check-packaged:** copy `build/check-packaged.js` and the workflow step; adjust the list of
   `Resources/` files it requires.
7. **Docs:** Administrator Mode box, the quarantine `xattr` line, and the self-update steps in
   Loupe's guide and release notes.
8. The first self-update can only happen from the first version that contains the updater; that
   version is installed by hand.
