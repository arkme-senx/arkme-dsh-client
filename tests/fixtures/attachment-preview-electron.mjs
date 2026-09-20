import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { installAttachmentPreviewNative } from '../../dist/attachment-preview-native.js';
const bundle = process.argv[2];
const output = process.argv[3] || '/private/tmp/arkme-attachment-preview-results';
app.setPath('userData', path.join(output, 'profile'));
const errors = [];
let videoBytes;
let imageBytes;
const result = { checks: [], screenshots: [] };
for (const name of ['arkme-session-selection:bootstrap', 'arkme-runtime:harness-version', 'arkme-desktop:attention-capabilities', 'arkme-runtime:page-ready-nonce', 'arkme-app-update:app-version', 'arkme:desktop-notification:permission-state']) ipcMain.on(name, event => { event.returnValue = null; });
for (const name of ['arkme-app-update:notice','arkme:runtime-update-notice:snapshot']) ipcMain.handle(name, () => null);
const server = createServer(async (req,res) => {
 try {
  const url = new URL(req.url,'http://localhost');
  if (url.pathname === '/arkme-self/api') { for await (const _ of req) {} res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ok:true,data:{state:'missing',receivedBytes:0,totalBytes:300}})); return; }
  if (url.pathname.includes('/media') && url.searchParams.get('ref') === 'video' && videoBytes) { res.setHeader('Content-Type','video/webm'); res.end(videoBytes); return; }
  if (url.pathname.includes('/media')) { res.setHeader('Content-Type','image/png'); res.end(imageBytes); return; }
  const file = url.pathname === '/' ? '/tests/fixtures/attachment-preview.html' : url.pathname;
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(await readFile(path.join(bundle, file)));
 } catch { res.statusCode=404; res.end(); }
});
const wait = async (fn,label) => { for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25))}throw Error('Timeout '+label) };
const js=(win,code)=>win.webContents.executeJavaScript(code,true);
let main;
async function run() {
try {
 await mkdir(output,{recursive:true}); await app.whenReady(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 main=new BrowserWindow({show:true,width:1100,height:800,webPreferences:{preload:path.resolve('dist/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 main.webContents.on('console-message', details=>{if(details.level==='error')errors.push(details.message)});
 const manager=installAttachmentPreviewNative(main,()=>origin);
 main.webContents.setWindowOpenHandler(details=>manager.handle(details)??{action:'deny'});
 await main.loadURL(origin); await wait(()=>js(main,'typeof smokeOpen === "function"'),'fixture loaded');
 imageBytes = Buffer.from(await js(main, `(() => {const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;const ctx=canvas.getContext('2d');ctx.fillStyle='#4858d8';ctx.fillRect(0,0,800,600);ctx.fillStyle='white';ctx.font='48px sans-serif';ctx.fillText('Arkme preview',240,310);return canvas.toDataURL('image/png').split(',')[1]})()`), 'base64');
 videoBytes = Buffer.from(await js(main, `(async () => {
   const canvas=document.createElement('canvas');canvas.width=320;canvas.height=200;
   const context=canvas.getContext('2d');context.fillStyle='blue';context.fillRect(0,0,320,200);
   const stream=canvas.captureStream(20);const recorder=new MediaRecorder(stream,{mimeType:'video/webm'});const parts=[];
   recorder.ondataavailable=e=>parts.push(e.data);const done=new Promise(resolve=>recorder.onstop=resolve);
   recorder.start();const draw=setInterval(()=>{context.fillStyle='red';context.fillRect(0,0,Math.random()*320,200)},50);
   await new Promise(resolve=>setTimeout(resolve,500));recorder.stop();await done;clearInterval(draw);stream.getTracks().forEach(track=>track.stop());
   return Array.from(new Uint8Array(await new Blob(parts).arrayBuffer()));
 })()`));
 await js(main,'document.querySelector("[data-arkme-file-card]").click()');
 const child=BrowserWindow.getAllWindows().find(w=>w!==main); assert(child);
 await wait(()=>js(child,'document.body.textContent.includes("方案.pdf")'),'file content');
 assert.equal(await js(main,'!!document.querySelector("[role=dialog]")'),false);
 assert.equal(await js(child,'document.title'),'方案.pdf');
 assert.equal(await js(child,'getComputedStyle(document.querySelector("[role=dialog]")).outlineStyle'),'none');
 assert.equal(await js(child,'!!document.querySelector("[aria-label=关闭文件预览]")'),false);
 assert.equal(await js(main,'document.body.style.overflow'), '');
 await js(main,'document.querySelector("input").focus(); document.querySelector("input").value="继续聊天"');
 assert.equal(await js(main,'document.querySelector("input").value'),'继续聊天'); result.checks.push('cached file opens preview; chat input remains usable');
 await js(main, 'window.showSaveFilePicker=async()=>{throw Error("wrong opener picker")};void 0');
 await js(child, 'window.showSaveFilePicker=async function(){ window.pickerOwner=this===window; throw new DOMException("cancelled","AbortError") };document.querySelector("[aria-label=另存为文件]").click()');
 await wait(()=>js(child,'window.pickerOwner===true'),'child save picker');
 assert.equal(await js(child,'document.body.textContent.includes("保存失败") || document.body.textContent.includes("cancelled")'),false);result.checks.push('save picker belongs to child; cancellation is not an error');
 await js(main,'smokeOpen(1)'); await wait(()=>js(child,'!!document.querySelector("[data-arkme-image-preview-viewport]")'),'image');
 assert.equal(BrowserWindow.getAllWindows().length,2); assert.equal(child.isModal(),false); main.minimize(); assert(!child.isMinimized()); main.restore(); result.checks.push('single native window for file and image');
 assert.equal(await js(child,'document.title'),'图片.png');
 assert.equal(await js(child,'getComputedStyle(document.querySelector("[role=dialog]")).outlineStyle'),'none');
 assert.equal(await js(child,'!!document.querySelector("[data-arkme-preview-close]")'),false);
 result.checks.push('filename title, no container focus outline or duplicate close button');
 await js(main, 'Object.defineProperty(navigator,"clipboard",{configurable:true,value:{write:async()=>{throw Error("wrong opener clipboard")}}});void 0');
 await js(child, 'Object.defineProperty(navigator,"clipboard",{configurable:true,value:{write:async function(items){window.copyCalled=true;try{await items[0].getType("image/png")}catch(error){window.copyError=String(error);throw error}window.copyOwner=this===navigator.clipboard}}});document.querySelector("[aria-label=复制图片]").click()');
 await wait(()=>js(child,'window.copyOwner===true'),'child clipboard'); result.checks.push('copy uses child clipboard and image conversion');
 await js(child,'document.body.click()'); assert(!child.isDestroyed()); result.checks.push('outside click retains preview');
 await js(child,'document.querySelector("[role=dialog]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))');
 await wait(()=>js(child,'document.body.textContent.includes("方案.pdf")'),'keyboard navigation'); result.checks.push('keyboard paging');
 child.minimize(); await js(main,'smokeOpen(0)'); await wait(()=>!child.isMinimized(),'restore minimized');
 child.setSize(700,500); await new Promise(r=>setTimeout(r,100));
 await writeFile(path.join(output,'preview-file-macos.png'),(await child.webContents.capturePage()).toPNG());result.screenshots.push('preview-file-macos.png');
 await writeFile(path.join(output,'chat-macos.png'),(await main.webContents.capturePage()).toPNG());result.screenshots.push('chat-macos.png');
 await js(main,'smokeOpen(1)'); await wait(()=>js(child,'!!document.querySelector("img")'),'image again');
 await writeFile(path.join(output,'preview-image-macos.png'),(await child.webContents.capturePage()).toPNG());result.screenshots.push('preview-image-macos.png');
 await js(main,'smokeOpen(2)'); await wait(()=>js(child,'!!document.querySelector("video")'),'video controls'); result.checks.push('video mounts in child');
 await js(child,'window.oldVideo=document.querySelector("video"); oldVideo.loop=true; oldVideo.play()');
 await wait(()=>js(child,'!oldVideo.paused'),'real video playing');
 await js(main,'smokeOpen(1)'); await wait(()=>js(child,'oldVideo.paused && !oldVideo.hasAttribute("src")'),'old video stopped');result.checks.push('switching attachments stops real video playback');
 child.close(); await wait(()=>BrowserWindow.getAllWindows().length===1,'native close');
 await js(main,'smokeSingle()'); const second=BrowserWindow.getAllWindows().find(w=>w!==main); assert(second);
 await wait(()=>js(second,'document.body.textContent.includes("方案.pdf")'),'reopen');
 assert.equal(await js(second,'!!document.querySelector("[aria-label=上一个文件]")'),false);
 assert.equal(second.getBounds().width,700);
 second.setSize(560,400); await new Promise(r=>setTimeout(r,100));
 assert.equal(await js(second,'Array.from(document.querySelectorAll("[aria-label=打开文件],[aria-label=另存为文件],[aria-label=打开文件夹]")).every(button=>{const rect=button.getBoundingClientRect();return rect.top>=0 && rect.bottom<=innerHeight && rect.left>=0 && rect.right<=innerWidth})'),true);
 await writeFile(path.join(output,'preview-small-macos.png'),(await second.webContents.capturePage()).toPNG());result.screenshots.push('preview-small-macos.png');
 result.checks.push('close/reopen, remembered size, hidden single-item navigation');
 await js(main,'smokeLogout()'); await wait(()=>BrowserWindow.getAllWindows().length===1,'logout');result.checks.push('logout clears native child');
 assert.deepEqual(errors,[]); result.status='passed';
} catch(error) {result.status='failed';result.error=String(error.stack||error);result.errors=errors; const child=BrowserWindow.getAllWindows().find(w=>w!==main);if(child)result.debug=await js(child,'({text:document.body.textContent,called:window.copyCalled,error:window.copyError,owner:window.copyOwner})');process.exitCode=1;}
await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2)); server.close();app.exit(result.status==='passed'?0:1);

}
void run();
