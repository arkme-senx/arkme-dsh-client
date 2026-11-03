const {contextBridge,ipcRenderer}=require('electron');
const invoke=(name,...args)=>ipcRenderer.invoke('arkme-screenshot:'+name,...args);
contextBridge.exposeInMainWorld('arkmeScreenshot',{version:1,context:()=>invoke('context'),ready:()=>invoke('ready'),profile:stage=>invoke('profile',stage),close:()=>invoke('close'),select:()=>invoke('select')});
