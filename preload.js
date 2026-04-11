const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  whipCrack: () => ipcRenderer.send('whip-crack'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  toggleOverlay: () => ipcRenderer.send('toggle-overlay'),
  quitApp: () => ipcRenderer.send('quit-app'),
  onSpawnWhip: (fn) => ipcRenderer.on('spawn-whip', () => fn()),
  onDropWhip: (fn) => ipcRenderer.on('drop-whip', () => fn()),
  onLinuxOverlayMode: (fn) => ipcRenderer.on('set-linux-overlay-mode', (_event, payload) => fn(payload)),
});
