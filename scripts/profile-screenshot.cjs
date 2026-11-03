// Isolated native-stage benchmark: retains no screenshots or window metadata.
// Run: node_modules/.bin/electron scripts/profile-screenshot.cjs
const {app,desktopCapturer,screen,systemPreferences}=require('electron');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
app.setPath('userData',path.join(app.getPath('temp'),'arkme-screenshot-profile'));
app.whenReady().then(async()=>{
 try{
  const permission=process.platform==='darwin'?systemPreferences.getMediaAccessStatus('screen'):'granted';
  if(permission!=='granted')throw new Error(`Screen permission is ${permission}; benchmark did not request permission or capture pixels.`);
  const {readScreenshotWindows}=await import(pathToFileURL(path.resolve(__dirname,'../dist/native-screenshot-windows.js')).href);
  const displays=screen.getAllDisplays();
  for(let run=1;run<=5;run++){
   const started=performance.now();readScreenshotWindows();const windowsMs=performance.now()-started;
   const captures=new Map();const samples=[];
   await Promise.all(displays.map(async d=>{
    const width=Math.round(d.size.width*d.scaleFactor),height=Math.round(d.size.height*d.scaleFactor);
    const scale=Math.min(1,16384/width,16384/height,Math.sqrt(64000000/(width*height)));
    const thumbnailSize={width:Math.floor(width*scale),height:Math.floor(height*scale)};
    const key=`${thumbnailSize.width}x${thumbnailSize.height}`;
    if(!captures.has(key)){
     const t=performance.now();captures.set(key,desktopCapturer.getSources({types:['screen'],thumbnailSize}).then(sources=>({sources,captureMs:performance.now()-t})));
    }
    const {sources,captureMs}=await captures.get(key);
    const source=sources.find(s=>s.display_id===String(d.id))??(displays.length===1?sources[0]:undefined);
    if(!source||source.thumbnail.isEmpty())throw Error('Empty capture');
    const t=performance.now(),png=source.thumbnail.toPNG(),encoded=performance.now();
    png.toString('base64');
    samples.push({size:key,captureMs,pngMs:encoded-t,base64Ms:performance.now()-encoded});
   }));
   console.log(JSON.stringify({run,windowsMs,totalNativeMs:performance.now()-started,samples}));
  }
  app.exit(0);
 }catch(error){console.error(error.message);app.exit(1);}
});
setTimeout(()=>{console.error('Benchmark timeout');app.exit(1)},30000).unref();
