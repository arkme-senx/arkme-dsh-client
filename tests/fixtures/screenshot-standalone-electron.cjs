// Real capture + production IPC, preload, bundle, and HTTP handlers. No business account/data.
// argv[2]: plugin checkout with lib/screenshot-editor.js and compiled route in lib/screenshot-test.
const {app,BrowserWindow,systemPreferences}=require('electron');
const {createServer}=require('node:http');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
process.env.ARKME_SCREENSHOT_PROFILE='1';
const busyMode=process.argv.includes('--busy');
const held=[];let releaseBusy,allBusyReady;const allBusy=new Promise(r=>allBusyReady=r);
const selectionMode=process.argv.includes('--selection'),buttonMode=process.argv.includes('--button');
const rounds=Number(process.argv.find(arg=>arg.startsWith('--rounds='))?.split('=')[1]??(selectionMode?4:10));
assert.ok(Number.isInteger(rounds)&&rounds>0&&rounds<=200,'rounds must be 1..200');
app.setPath('userData',path.join(app.getPath('temp'),'arkme-screenshot-standalone-test'));
app.whenReady().then(async()=>{
 let server,owner,api;
 try{
  if(process.platform==='darwin'&&systemPreferences.getMediaAccessStatus('screen')!=='granted')throw Error('Screen permission not granted; no permission prompt requested');
  const plugin=path.resolve(process.argv[2]);
  const {createScreenshotEditorRoutes}=await import(pathToFileURL(path.join(plugin,'lib/screenshot-test/screenshot-editor-route.mjs')).href);
  const routes=createScreenshotEditorRoutes(await fs.readFile(path.join(plugin,'lib/screenshot-editor.js')));
  const requests=[];
  server=createServer((req,res)=>{
   const url=new URL(req.url,'http://localhost');requests.push({method:req.method,path:url.pathname});
   if(url.pathname.startsWith('/busy/')){held.push(res);if(held.length===6)allBusyReady();return;}
   const route=routes.find(r=>r.path===url.pathname);
   if(route)return route.handler(req,res);
   if(url.pathname==='/'&&!url.search)return res.end('<html><body>Isolated owner</body></html>');
   res.writeHead(404).end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  owner=new BrowserWindow({show:false,webPreferences:{sandbox:true,preload:path.resolve(__dirname,'screenshot-standalone-owner-preload.cjs')}});
  const {installScreenshotIpc}=await import(pathToFileURL(path.resolve(__dirname,'../../dist/desktop-screenshot-ipc.js')).href);
  api=installScreenshotIpc({main:()=>owner,origin:()=>origin,scope:()=>'isolated-test',allowed:id=>id===owner.webContents.id,
   preload:()=>{throw Error('Legacy preload must not be used')},editorPreload:()=>path.resolve(__dirname,'../../dist/screenshot-preload.cjs')});
  await owner.webContents.session.cookies.set({url:origin,name:"diagnostic-owner",value:"fixture-only"});
  await owner.loadURL(origin);
  if(busyMode){
   await owner.webContents.executeJavaScript('for(let i=0;i<6;i++)void fetch("/busy/"+i)');
   await allBusy;
   releaseBusy=setTimeout(()=>held.forEach(res=>res.end('released')),6000);
  }
  assert.equal(await owner.webContents.executeJavaScript('window.screenshotTest.register()'),true);
  let verify;
  const times=[],errors=[],windowIds=[],rssMiB=[];
  app.on('web-contents-created',(_event,contents)=>contents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message)}));
  const info=console.info;
  console.info=(...args)=>{
   info(...args);
   if(args[0]!=='[arkme-screenshot-profile]')return;
   const record=JSON.parse(args[1]);if(record.stage!=='show-called')return;
   times.push(record.elapsedMs);
   const ids=BrowserWindow.getAllWindows().filter(w=>w!==owner).map(w=>w.webContents.id).sort();
   if(windowIds.length)assert.deepEqual(ids,windowIds);else windowIds.push(...ids);
   verify=(async()=>{
    for(const window of BrowserWindow.getAllWindows().filter(w=>w!==owner)){
     assert.equal(new URL(window.webContents.getURL()).pathname,'/arkme-self/screenshot');
     assert.notEqual(window.webContents.session,owner.webContents.session);
     assert.equal(window.webContents.session.isPersistent(),false);
     assert.deepEqual(await window.webContents.session.cookies.get({url:origin}),[]);
     const state=await window.webContents.executeJavaScript(`({editor:!!document.querySelector('[aria-label="截图编辑"]'),harness:typeof window.__DSH_BOOT__!=='undefined',businessBridge:typeof window.arkmeDesktop!=='undefined',images:document.querySelectorAll('canvas').length,resources:performance.getEntriesByType('resource').map(r=>({protocol:new URL(r.name).protocol,path:new URL(r.name).pathname}))})`);
     assert.equal(state.editor,true);assert.equal(state.harness,false);assert.equal(state.businessBridge,false);assert.ok(state.images>0);
     assert.ok(state.resources.every(resource=>resource.path==='/arkme-self/screenshot/editor.js'||resource.protocol==='blob:'));
    }
    if(selectionMode){
     const windows=BrowserWindow.getAllWindows().filter(w=>w!==owner);assert.ok(windows.length>=2);
     const selected=windows[0],other=windows[1];
     const operation=times.length%2?'complete':'close';
     const selectedResult=await selected.webContents.executeJavaScript(`(async()=>{const b=window.arkmeScreenshot,c=await b.context();return b.select(c.requestId)})()`);
     assert.equal(selectedResult,true);assert.equal(other.isDestroyed(),false);assert.equal(other.isVisible(),false);
     assert.equal(await other.webContents.executeJavaScript('window.arkmeScreenshot.context()'),null);
     const result=await selected.webContents.executeJavaScript(`(async()=>{const b=window.arkmeScreenshot,c=await b.context();if(${JSON.stringify(operation)}==='close'){await b.close(c.requestId);return true;}const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;canvas.getContext('2d').fillRect(0,0,1,1);return b.complete(canvas.toDataURL('image/png').split(',')[1],c.requestId)})()`);
     assert.equal(result,true);
    }
   })().finally(()=>api.cancel());
  };
  for(let run=1;run<=rounds;run++){
   if(selectionMode||buttonMode){
    const result=await owner.webContents.executeJavaScript('window.screenshotTest.capture(crypto.randomUUID())');
    assert.equal(result.status,selectionMode&&run%2?'captured':'cancelled');
   }else await api.captureClipboard(owner);
   await verify;
   rssMiB.push(Math.round(process.memoryUsage().rss/1024/1024));
   for(const window of BrowserWindow.getAllWindows().filter(w=>w!==owner)){
    assert.equal(window.isVisible(),false);
    assert.equal(window.webContents.listenerCount('dom-ready'),0,'retained capture load listener');
    assert.equal(window.webContents.listenerCount('did-finish-load'),0,'retained capture load listener');
    const state=await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({canvas:document.querySelectorAll('canvas').length,editor:!!document.querySelector('[aria-label="截图编辑"]')}))))`);
    assert.equal(state.canvas,0);assert.equal(state.editor,false);
   }
  }
  assert.equal(times.length,rounds);
  if(busyMode)assert.ok(times[0]<3000,'Screenshot waited for occupied business connections');
  assert.deepEqual(errors,[]);
  assert.equal(requests.filter(r=>r.method==='HEAD').length,0);
  assert.equal(requests.filter(r=>r.path.startsWith('/arkme-self/screenshot')).length,4,'Both editors should load exactly once');
  assert.ok(requests.every(r=>['/','/arkme-self/screenshot','/arkme-self/screenshot/editor.js'].includes(r.path)||r.path.startsWith('/busy/')));
  console.log(JSON.stringify({result:'passed',busyMode,selectionMode,buttonMode,rssMiB,showCalledMs:times,capabilityProbes:0,requests:requests.length,businessBridge:false,harnessBoot:false,reusedWindowIds:windowIds,resetClearedPixels:true}));
  app.exit(0);
 }catch(error){console.error(error);api?.cancel();app.exit(1);}finally{clearTimeout(releaseBusy);held.forEach(res=>res.end('released'));owner?.destroy();server?.close();}
});
setTimeout(()=>app.exit(1),Math.max(45000,rounds*2000)).unref();
