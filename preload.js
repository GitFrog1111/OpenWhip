const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  whipCrack: () => ipcRenderer.send('whip-crack'),
  dropWhip: () => ipcRenderer.send('drop-whip-request'),
  whipGone: () => ipcRenderer.send('whip-gone'),
  sendState: (state) => ipcRenderer.send('whip-state', state),
  sendGhost: (pts) => ipcRenderer.send('whip-ghost', pts),
  onInit: (fn) => ipcRenderer.on('init', (_e, cfg) => fn(cfg)),
  onSpawnWhip: (fn) => ipcRenderer.on('spawn-whip', (_e, point) => fn(point)),
  onDropWhip: (fn) => ipcRenderer.on('drop-whip', () => fn()),
  onExportWhip: (fn) => ipcRenderer.on('export-whip', () => fn()),
  onImportWhip: (fn) => ipcRenderer.on('import-whip', (_e, state) => fn(state)),
  onGhost: (fn) => ipcRenderer.on('ghost', (_e, pts) => fn(pts)),
});
