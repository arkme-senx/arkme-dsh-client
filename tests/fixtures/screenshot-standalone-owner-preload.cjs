const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('screenshotTest',{capture:(id)=>ipcRenderer.invoke('arkme-screenshot:capture',id),register:()=>ipcRenderer.invoke('arkme-screenshot:enable-standalone','reset-v1')});
