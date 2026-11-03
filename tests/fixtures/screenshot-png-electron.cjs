const {app,desktopCapturer,nativeImage,systemPreferences}=require('electron');
const assert=require('node:assert/strict');const {pathToFileURL}=require('node:url');const path=require('node:path');
app.whenReady().then(async()=>{
 try{
  const {encodeOpaqueBgraPng}=await import(pathToFileURL(path.resolve(__dirname,'../../dist/screenshot-fast-png.js')).href);
  const known=Buffer.from([3,2,1,255,30,20,10,255,0,0,255,255,255,0,0,255]);
  assert.deepEqual(nativeImage.createFromBuffer(encodeOpaqueBgraPng(known,2,2)).toBitmap(),known);
  assert.equal(systemPreferences.getMediaAccessStatus('screen'),'granted');
  const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:3840,height:2160}});
  for(const source of sources){
   const image=source.thumbnail,{width,height}=image.getSize(),bitmap=image.toBitmap();
   const a=performance.now(),png=encodeOpaqueBgraPng(bitmap,width,height),b=performance.now();
   assert.ok(png);const original=image.toPNG(),c=performance.now();
   assert.deepEqual(nativeImage.createFromBuffer(png).toBitmap(),nativeImage.createFromBuffer(original).toBitmap());
   console.log(JSON.stringify({width,height,fastMs:b-a,nativeMs:c-b,pixelExact:true,fastBytes:png.length,nativeBytes:original.length}));
  }
  app.exit(0);
 }catch(e){console.error(e);app.exit(1);}
});
