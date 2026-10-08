const { contextBridge, ipcRenderer } = require('electron');

const channels = ['status', 'session', 'lint', 'scratch-set', 'open-view', 'models', 'rewrite-reset', 'settings-changed', 'auto-reason'];

contextBridge.exposeInMainWorld('quill', {
  ready: () => ipcRenderer.invoke('ready'),
  scratchText: (text) => ipcRenderer.invoke('scratch-text', text),
  applyFix: (issue, suggestion) => ipcRenderer.invoke('apply-fix', { issue, suggestion }),
  fixAll: () => ipcRenderer.invoke('fix-all'),
  rewrite: (mode) => ipcRenderer.invoke('rewrite', mode),
  cancelRewrite: () => ipcRenderer.invoke('cancel-rewrite'),
  replace: (text) => ipcRenderer.invoke('replace', text),
  copy: (text) => ipcRenderer.invoke('copy', text),
  resize: (height) => ipcRenderer.invoke('resize', height),
  close: () => ipcRenderer.invoke('close'),
  retryFocus: () => ipcRenderer.invoke('retry-focus'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  models: {
    state: () => ipcRenderer.invoke('models:state'),
    download: (id) => ipcRenderer.invoke('models:download', id),
    cancel: () => ipcRenderer.invoke('models:cancel'),
    remove: (id) => ipcRenderer.invoke('models:remove', id),
    reveal: () => ipcRenderer.invoke('models:reveal'),
  },
  welcomeDone: () => ipcRenderer.invoke('welcome-done'),
  removeExcluded: (id) => ipcRenderer.invoke('excluded:remove', id),
  pauses: () => ipcRenderer.invoke('pause:labels'),
  autoFix: (reason) => ipcRenderer.invoke('auto-fix', reason),
  diagnostics: () => ipcRenderer.invoke('diagnostics'),
  addWord: (word) => ipcRenderer.invoke('dict:add', word),
  removeWord: (word) => ipcRenderer.invoke('dict:remove', word),
  ignoreAlways: (issue) => ipcRenderer.invoke('ignore:add', issue),
  unignore: (key) => ipcRenderer.invoke('ignore:remove', key),
  resumeApp: (id) => ipcRenderer.invoke('pause:resume-app', id),
  resumeAll: () => ipcRenderer.invoke('pause:resume-all'),
  openAccessibility: () => ipcRenderer.invoke('open-accessibility'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  on: (channel, handler) => {
    if (!channels.includes(channel)) return () => {};
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
