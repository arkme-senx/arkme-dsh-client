const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pickerComparison', Object.freeze({
  method: () => ipcRenderer.invoke('picker-comparison:method'),
  native: () => ipcRenderer.invoke('picker-comparison:native'),
  restart: () => ipcRenderer.invoke('picker-comparison:restart'),
  log: details => ipcRenderer.send('picker-comparison:log', details),
}));
