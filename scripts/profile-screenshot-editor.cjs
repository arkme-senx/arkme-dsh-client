// Built isolated editor directory is argv[2]; no production session or account is used.
const {app,BrowserWindow}=require('electron');
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const {pathToFileURL}=require('node:url');
process.env.ARKME_SCREENSHOT_PROFILE='1';
app.setPath('userData',path.join(app.getPath('temp'),'arkme-screenshot-profile'));
app.whenReady().then(async()=>{
 let server,owner;
 try{
  const root=path.resolve(process.argv[2]);
  server=http.createServer(async(req,res)=>{
   try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/'&&!url.searchParams.has('arkmeScreenshot'))return res.end('<html><body>Diagnostic owner</body></html>');
    const file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
    res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':'text/html');res.end(await fs.readFile(file));
   }catch{res.writeHead(404);res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  owner=new BrowserWindow({show:false,webPreferences:{sandbox:true}});await owner.loadURL(origin);
  const {installScreenshotIpc}=await import(pathToFileURL(path.resolve(__dirname,'../dist/desktop-screenshot-ipc.js')).href);
  const api=installScreenshotIpc({main:()=>owner,origin:()=>origin,scope:()=>'isolated-profile',preload:()=>path.resolve(__dirname,'./profile-screenshot-preload.cjs'),allowed:id=>id===owner.webContents.id});
  const info=console.info;console.info=(...args)=>{info(...args);if(args[0]==='[arkme-screenshot-profile]'&&JSON.parse(args[1]).stage==='show-called')setTimeout(()=>api.cancel(),50);};
  for(let run=1;run<=5;run++){console.log(JSON.stringify({run}));await api.captureClipboard(owner);}
  app.exit(0);
 }catch(error){console.error(error);app.exit(1);}finally{owner?.destroy();server?.close();}
});
setTimeout(()=>app.exit(1),45000).unref();
