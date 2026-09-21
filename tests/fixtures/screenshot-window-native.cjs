// Run after building with this repo's Electron. Creates two synthetic windows, never captures desktop pixels.
const {app,BrowserWindow,screen}=require('electron');
const assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
app.whenReady().then(async()=>{
 const windows=[];
 try {
  const {readScreenshotWindows}=await import(pathToFileURL(path.resolve(__dirname,'../../dist/native-screenshot-windows.js')).href);
  const display=screen.getPrimaryDisplay();
  const options={show:false,frame:false,resizable:false,alwaysOnTop:true,...(process.platform==='darwin'?{type:'panel'}:{}),webPreferences:{sandbox:true}};
  const back=new BrowserWindow({...options,x:display.bounds.x+100,y:display.bounds.y+100,width:400,height:300});windows.push(back);
  const front=new BrowserWindow({...options,x:display.bounds.x+150,y:display.bounds.y+150,width:300,height:200});windows.push(front);
  for(const w of windows){await w.loadURL('data:text/html,<body style="background:%232a61b8">Arkme window snap verification</body>');w.showInactive();}
  front.moveTop();await new Promise(r=>setTimeout(r,200));
  const bounds=w=>process.platform==='win32'?screen.dipToScreenRect(null,w.getBounds()):w.getBounds();
  const matches=(a,b)=>['x','y','width','height'].every(k=>Math.abs(a[k]-b[k])<=2);
  const snapshot=readScreenshotWindows();
  const frontIndex=snapshot.findIndex(r=>matches(r,bounds(front))),backIndex=snapshot.findIndex(r=>matches(r,bounds(back)));
  assert.ok(frontIndex>=0&&backIndex>frontIndex,`Incorrect native bounds/order: front=${frontIndex}, back=${backIndex}`);
  const frontBounds=bounds(front);front.hide();await new Promise(r=>setTimeout(r,100));
  assert.equal(readScreenshotWindows().some(r=>matches(r,frontBounds)),false,'Hidden window was included');
  console.log(JSON.stringify({platform:process.platform,nativeBounds:true,frontToBack:true,hiddenExcluded:true}));
  app.exitCode=0;
 }catch(e){console.error(e);app.exitCode=1;}finally{windows.forEach(w=>w.destroy());app.exit(app.exitCode);}
});
