const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('platformBrowser', {
  open: (url) => ipcRenderer.invoke('platform-open', url),
  back: () => ipcRenderer.invoke('platform-back'),
  forward: () => ipcRenderer.invoke('platform-forward'),
  reload: () => ipcRenderer.invoke('platform-reload'),
  getUrl: () => ipcRenderer.invoke('platform-url'),
  cdp: () => ipcRenderer.invoke('cdp-config'),
});
