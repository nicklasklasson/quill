const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('badge', {
  onState: (handler) => ipcRenderer.on('badge-state', (_e, state) => handler(state)),
  click: () => ipcRenderer.invoke('badge-click'),
  menu: () => ipcRenderer.invoke('badge-menu'),
});
