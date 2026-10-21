// Run in separate Electron processes with the same isolated app-data directory.
// Consumes the plugin's actual composer/auth/sync modules bundled by its fixture entry.
const {app,BrowserWindow,ipcMain}=require('electron');
const {createServer}=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const root=process.env.ARKME_DRAFT_SMOKE_DATA, asset=process.env.ARKME_DRAFT_SMOKE_ASSET, phase=process.env.ARKME_DRAFT_SMOKE_PHASE;
if(!root||!asset||!phase) throw new Error('Required: ARKME_DRAFT_SMOKE_DATA, ARKME_DRAFT_SMOKE_ASSET, ARKME_DRAFT_SMOKE_PHASE');
app.setPath('userData',path.join(root,'browser'));
let window,server,manager,allowQuit=false;
const keys=['source:private_chat:a','source:group_chat:b','arko'];
const values=['重启仍保留的私聊草稿','group draft 中文','Arko draft'];
app.on('before-quit',event=>{
 if(allowQuit)return;
 event.preventDefault();
 void manager.prepareToClose().then(()=>{allowQuit=true;server.close();console.log(`PASS ${phase} port=${server.address()?.port??'closed'}`);app.quit()}).catch(error=>{console.error(error);app.exit(1)});
});
(async()=>{
 await app.whenReady();
 for(const channel of ['arkme-session-selection:bootstrap','arkme-desktop:attention-capabilities','arkme-desktop:branding-snapshot','arkme-runtime:page-ready-nonce','arkme-app-update:app-version','arkme-app-update:app-version-code','arkme:desktop-notification:permission-state'])ipcMain.on(channel,event=>{event.returnValue=null});
 ipcMain.on('arkme-runtime:harness-version',event=>{event.returnValue='0.1.5-rc.2'});
 for(const channel of ['arkme:runtime-update-notice:snapshot','arkme-app-update:notice','arkme:desktop-notification:refresh-permission'])ipcMain.handle(channel,()=>null);
 server=createServer(async(req,res)=>{
  if(req.url.endsWith('.js')){try{res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(path.dirname(asset),path.basename(req.url))))}catch{res.statusCode=404;res.end()}return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><script type="module" src="/entry.js"></script>')
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const clientRoot=path.resolve(__dirname,'../..');
 const {installConversationWindowIpc}=await import(pathToFileURL(path.join(clientRoot,'dist/conversation-window-ipc.js')));
 window=new BrowserWindow({show:false,webPreferences:{preload:path.join(clientRoot,'dist/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 manager=installConversationWindowIpc({main:()=>window,origin:()=>origin,scope:()=>origin,preload:()=>path.join(clientRoot,'dist/preload.cjs'),draftsDirectory:()=>path.join(root,'drafts')});
 await window.loadURL(origin+(phase==='other-account'?'/?user=43':''));
 for(let attempt=0;attempt<100;attempt++) {if(await window.webContents.executeJavaScript('typeof draftReady === "function"'))break;await new Promise(resolve=>setTimeout(resolve,20))}
 await window.webContents.executeJavaScript('draftReady()');
 if(phase==='write'||phase==='navigate')await window.webContents.executeJavaScript(keys.map((key,i)=>`draftWrite(${JSON.stringify(key)},${JSON.stringify(values[i])})`).join(';'));
 else if(phase==='read'||phase==='clear'){
  for(let i=0;i<keys.length;i++)assert.equal(await window.webContents.executeJavaScript(`draftRead(${JSON.stringify(keys[i])}).text`),values[i]);
  if(phase==='clear')await window.webContents.executeJavaScript(keys.map(key=>`draftClear(${JSON.stringify(key)})`).join(';'));
 } else if(phase==='read-cleared'||phase==='other-account')for(const key of keys)assert.equal(await window.webContents.executeJavaScript(`draftRead(${JSON.stringify(key)}).text`),'');
 else throw new Error('Unknown phase');
 if(phase==='navigate'){
  // Drain the live editor before replacing it with a native status page.
  await manager.prepareToClose();
  await window.loadURL('data:text/html,<p>Starting</p>');
  // The status document has no editor callback: a stale handshake must not
  // turn a subsequent shutdown into a five-second rejection.
  await manager.prepareToClose();
 }
 await fs.writeFile(path.join(root,phase+'.json'),JSON.stringify({phase,origin}));
 // Do not wait for the 40 ms edit timer: the real close barrier must flush it.
 app.quit();
})().catch(error=>{console.error(error);app.exit(1)});
