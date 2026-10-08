# Quill

A private writing assistant for the Mac, built for people who write English as a second language. Quill checks what you type in any app — Slack, Mail, your browser, Jira — and suggests fixes and rewrites right next to the text field.

**Nothing you write leaves your Mac.** Spelling and grammar checks and the writing model that suggests corrections and rewrites both run on your own computer. There are no accounts, no analytics and no cloud service.

**→ [Download the latest version](https://github.com/nicklasklasson/quill/releases/latest)** (the `.dmg` file), and see *Quill - Install and quick start.pdf* on the same page.

## What it does

- **A badge in every text field.** Click into a field and a small badge appears in its corner: a checkmark when the text looks good, or the number of things to fix.
- **Fixes as you type.** Spelling and grammar issues show up instantly. When you pause, the writing model takes a closer look and catches mix-ups that spell-checkers miss, like "wit" for "with" or "you" for "your".
- **Rewrites.** Fix, Natural, Concise, Formal and Friendly rewrite the whole text. Changed words are highlighted, and **Replace** puts the result back into the field.
- **Your dictionary.** Add names, products and jargon (PaymentIQ, MID, …) so Quill leaves them alone, or tell it to always ignore a suggestion.
- **Pause when you want.** Pause in one app or everywhere for an hour or until tomorrow morning, or turn off checking in an app for good.

## Install

1. Download `Quill-<version>-universal.dmg` from [Releases](https://github.com/nicklasklasson/quill/releases/latest), open it and drag **Quill** to **Applications**.
2. Open Quill from Applications. The first time, macOS blocks it: go to **System Settings › Privacy & Security** and click **Open Anyway**.
3. Quill lives in the menu bar (a small feather). Its welcome panel lets you download the writing model, a one-time download of 2.5–7.4 GB. Spelling and grammar checks work without it.
4. Click into any text field. When macOS asks, allow Quill under **System Settings › Privacy & Security › Accessibility**. This is what lets Quill read and fix the field you're typing in.

Requires macOS 14 or later, on Apple Silicon or Intel.

## Privacy

- The writing model runs on your Mac through a bundled engine that only listens to Quill, has network access switched off and is unloaded after 10 idle minutes.
- The only time Quill goes online is the one-time model download from Hugging Face, which is checked against a fingerprint built into Quill before it's used.
- Quill skips password fields, search boxes and address bars, and doesn't look into Terminal or password managers. Your settings and dictionary are stored in `~/Library/Application Support/Quill` on your Mac.

## Questions

Nicklas Klasson — nicklas.klasson@paymentiq.com

---

## For developers

### Project layout

```
main.js                 Electron main process: menu bar, badge, panel, checks, rewrites, pauses
preload*.js             Bridges between the windows and the main process
src/panel.*             The panel; src/badge.* the badge in the field's corner
src/ax.js               Client for the native Accessibility helper
src/lint.js             Harper: instant spelling and grammar, with the user's dictionary
src/engine.js           Starts and talks to the bundled llama.cpp server
src/models.js           Model catalog and the verified, resumable download
src/modelcheck.js       Turns the model's corrected text into individual suggestions
src/prompts.js          Instructions for the model
native/QuillAX.swift    Accessibility helper: follows focus, reads and writes the field
build/                  Install steps, signing hook, entitlements
.github/workflows/      Builds the dmg on GitHub and publishes the release
docs/                   The install and quick start guide (attached to each release)
```

### Releasing

GitHub builds the dmg on its own Mac machines whenever a version tag is pushed (`.github/workflows/release.yml`). It publishes a release with the dmg, `RELEASE_NOTES.md` as the notes, and the guide in `docs/`. To release the version in `package.json`, update `RELEASE_NOTES.md`, then:

```
./release.sh
```

It commits and pushes, tags, waits for the build (about 10 minutes), downloads the dmg to `~/Downloads` and opens it.

### Building locally

Needs Node.js 20 or later and the Xcode command line tools.

```
npm install --no-audit --no-fund   # also unpacks Electron, compiles the helper, fetches the engine
npm start                          # run from source (uses Terminal's Accessibility permission)
npm run dist:mac                   # dist/Quill-<version>-universal.dmg
```

### Models

| Model | Download | Notes |
|---|---|---|
| Gemma 4 12B Instruct (Google DeepMind, June 2026) | 7.4 GB | Suggested on Apple Silicon with 16 GB or more |
| Qwen2.5 7B Instruct (2024) | 4.7 GB | The original model, kept for comparison |
| Qwen3 4B Instruct 2507 | 2.5 GB | Light: 8 GB Macs and Intel Macs |

All Apache 2.0. Download URLs are pinned to a repository revision and checked against SHA-256 fingerprints in `src/models.js`. The engine is llama.cpp, pinned in `build/fetch-engine.js`; spelling and grammar come from [Harper](https://writewithharper.com).
