import {contextBridge,ipcRenderer} from 'electron';
// No session restoration, business bootstrap, or synchronous IPC in this renderer.
const invoke=(name:string,...args:unknown[])=>ipcRenderer.invoke('arkme-screenshot:'+name,...args);
contextBridge.exposeInMainWorld('arkmeScreenshot',Object.freeze({
 version:1,
 context:()=>invoke('context'),ready:(token?:string)=>invoke('ready',token),
 onReset:(listener:()=>void)=>{const handler=()=>listener();ipcRenderer.on('arkme-screenshot:reset',handler);return()=>ipcRenderer.removeListener('arkme-screenshot:reset',handler);},
 profile:(stage:string,token?:string)=>invoke('profile',stage,token),
 select:(token?:string)=>invoke('select',token),close:(token?:string)=>invoke('close',token),
 complete:(png:string,token?:string)=>invoke('complete',png,token),save:(png:string,token?:string)=>invoke('save',png,token),
 askDsh:(png:string,token?:string)=>invoke('ask-dsh',png,token),
}));
