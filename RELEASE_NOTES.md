### New
- **Swedish.** Quill now checks Swedish as well as English, and you don't have to tell it which you're writing: it recognises the language of each sentence by itself. A message like "Hej! Kan du kolla PR:en? I think the build is broken." gets the Swedish part checked as Swedish and the English part as English.
- **Swenglish is fine.** English words in Swedish sentences (merchant, deploy, build) aren't flagged, and neither are Swedish words in English ones. The team dictionary applies to both languages.
- **Swedish spelling** comes from macOS's own Swedish spell checker, which knows compound words like "betalningsleverantör". When you pause, the writing model also catches de/dem, en/ett, var/vart, words split apart that belong together (särskrivning), and words spelled the way they sound.
- **Rewrites stay in the text's language.** Fix, Natural, Formal and the others answer in Swedish for Swedish text and never translate.
- **Language button.** The panel shows what Quill recognised, for example **Svenska ▾**. If it guessed wrong, click it and choose English or Svenska for that field.
- The setting "Skip text that doesn't look like English" is replaced by **Check Swedish too** (on by default).

### Updating
Request Administrator Mode in the PaymentIQ Self Service app, then choose **Update to Quill 0.1.15…** (or **Check for Updates…**) in the menu bar menu and click **Install and restart**.
