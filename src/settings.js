const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  hotkey: 'CommandOrControl+Alt+G',
  dialect: 'american',          // american | british | australian | canadian | indian
  isolateEnglish: false,        // skip text that doesn't look like English (useful when you also write Swedish)
  model: null,                  // 'standard' | 'light' once a model is chosen
  autoCheck: true,              // run the writing model in the background when typing pauses
  launchAtLogin: false,
  welcomed: false,
  alwaysOn: true,               // attach to every text field automatically and show the badge
  showInDock: true,             // a Dock icon as well as the menu bar icon
  pausedApps: [],               // [{ id, name, until }]: automatic checking paused in an app until a time
  pausedAllUntil: 0,            // automatic checking paused everywhere until this time (ms)
  dictionary: [],               // words that are always correct: names, products, jargon
  ignoredSuggestions: [],       // [{ problem, replacement }]: suggestions never to show again
  // Apps Quill never looks into automatically. The hotkey still works in them.
  excludedApps: [
    { id: 'com.apple.Terminal', name: 'Terminal' },
    { id: 'com.googlecode.iterm2', name: 'iTerm' },
    { id: 'dev.warp.Warp-Stable', name: 'Warp' },
    { id: 'com.1password.1password', name: '1Password' },
    { id: 'com.agilebits.onepassword7', name: '1Password 7' },
    { id: 'com.bitwarden.desktop', name: 'Bitwarden' },
    { id: 'com.apple.keychainaccess', name: 'Keychain Access' },
    { id: 'com.apple.Passwords', name: 'Passwords' },
  ],
};

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...saved };
    } catch (_) { /* first run */ }
  }

  get(key) { return this.data[key]; }
  all() { return { ...this.data }; }

  update(patch) {
    for (const key of Object.keys(patch)) {
      if (key in DEFAULTS) this.data[key] = patch[key];
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.warn('Could not save settings', err);
    }
    return this.all();
  }
}

module.exports = { Settings, DEFAULTS };
