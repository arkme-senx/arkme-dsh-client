import {app,BrowserWindow,globalShortcut,ipcMain,type IpcMainInvokeEvent} from 'electron';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';
import {ScreenshotShortcut} from './screenshot-shortcut.js';
export function installScreenshotShortcut(options:{main():BrowserWindow|null;origin():string|null;allowed(id:number):boolean}){
 const file=path.join(app.getPath('userData'),'screenshot-shortcut.json');
 let saved:unknown;try{saved=JSON.parse(readFileSync(file,'utf8')).accelerator;}catch{}
 let recording:number|undefined;
 let releaseRecording:(()=>void)|undefined;
 const trusted=(e:IpcMainInvokeEvent)=>{try{return e.senderFrame===e.sender.mainFrame && new URL(e.senderFrame!.url).origin===options.origin() && options.allowed(e.sender.id);}catch{return false;}};
 const controller=new ScreenshotShortcut(process.platform,globalShortcut,key=>{writeFileSync(file+'.tmp',JSON.stringify({accelerator:key}));renameSync(file+'.tmp',file);},()=>{
  if(recording!==undefined)return;
  const focused=BrowserWindow.getFocusedWindow();
  const target=focused && options.allowed(focused.webContents.id)?focused:options.main();
  if(target && !target.isDestroyed() && options.allowed(target.webContents.id))target.webContents.send('arkme-screenshot:shortcut-trigger');
 },saved);
 const publish=()=>{for(const w of BrowserWindow.getAllWindows())if(!w.isDestroyed()&&options.allowed(w.webContents.id))w.webContents.send('arkme-screenshot:shortcut-changed',controller.snapshot());};
 ipcMain.handle('arkme-screenshot:shortcut-get',e=>trusted(e)?controller.snapshot():null);
 ipcMain.handle('arkme-screenshot:shortcut-set',(e,key:unknown)=>{if(!trusted(e))throw Error('快捷键设置来源已失效');if(recording!==undefined&&recording!==e.sender.id)throw Error('另一窗口正在编辑快捷键');const result=controller.set(key);publish();return result;});
 ipcMain.handle('arkme-screenshot:shortcut-record',(e,value:unknown)=>{
  if(!trusted(e)||typeof value!=='boolean')return false;
  if(value){
   if(recording!==undefined)return recording===e.sender.id;
   recording=e.sender.id;controller.pause(true);
   const release=()=>{releaseRecording=undefined;e.sender.removeListener('destroyed',release);e.sender.removeListener('did-start-navigation',release);if(recording===e.sender.id){recording=undefined;controller.pause(false);publish();}};
   releaseRecording=release;
   e.sender.once('destroyed',release);e.sender.once('did-start-navigation',release);
  }else if(recording===e.sender.id){releaseRecording?.();}
  return true;
 });
 app.once('will-quit',()=>controller.dispose());
}
