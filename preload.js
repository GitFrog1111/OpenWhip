const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  whipCrack: () => ipcRenderer.send('whip-crack'),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  onSpawnWhip: (fn) => ipcRenderer.on('spawn-whip', () => fn()),
  onDropWhip: (fn) => ipcRenderer.on('drop-whip', () => fn()),
  onCrackPhrase: (fn) => ipcRenderer.on('crack-phrase', (e, text, kind) => fn(text, kind)),
  onSpawnHand: (fn) => ipcRenderer.on('spawn-hand', () => fn()),
  handPat: () => ipcRenderer.send('hand-pat'),
});
