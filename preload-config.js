const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  getPhrases: () => ipcRenderer.invoke('get-phrases'),
  savePhrases: (phrases) => ipcRenderer.send('save-phrases', phrases),
  startWhipping: () => ipcRenderer.send('start-whipping'),
});
