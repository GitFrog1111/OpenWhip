const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  // Legacy whip support (existing overlay code uses these)
  whipCrack: () => ipcRenderer.send('whip-crack'),
  onSpawnWhip: (fn) => ipcRenderer.on('spawn-whip', () => fn()),
  onDropWhip: (fn) => ipcRenderer.on('drop-whip', () => fn()),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),

  // Plugin system
  actionTriggered: (actionId) => ipcRenderer.send('action-triggered', actionId),
  onSpawnAction: (fn) => ipcRenderer.on('spawn-action', (_e, actionId) => fn(actionId)),
});
