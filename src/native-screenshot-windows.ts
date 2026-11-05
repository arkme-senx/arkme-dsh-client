import {readMacScreenshotWindows,readMacScreenshotWindowsAsync} from './macos-screenshot-windows.js';
import {readWindowsScreenshotWindows} from './windows-screenshot-windows.js';
import type {ScreenshotWindowRect} from './screenshot-window-geometry.js';
/** Optional enhancement: native API/permission failures must never block manual capture. */
export function readScreenshotWindows():ScreenshotWindowRect[] {
 try{
  if(process.platform==='darwin')return readMacScreenshotWindows();
  if(process.platform==='win32')return readWindowsScreenshotWindows();
 }catch{ /* Manual selection remains available. Do not log other applications' metadata. */ }
 return [];
}

/** Window snapping is optional. Never queue native calls or reuse a late snapshot
 * from a previous capture: the desktop may have changed in the meantime. */
export function createScreenshotWindowReader(
 read:()=>Promise<ScreenshotWindowRect[]> = async()=>process.platform==='darwin' ? readMacScreenshotWindowsAsync() : readScreenshotWindows(),
 maxWaitMs=100,
):()=>Promise<ScreenshotWindowRect[]> {
 let inFlight=false;
 return async()=>{
  if(inFlight)return [];
  inFlight=true;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const result=Promise.resolve().then(read).catch(()=>[] as ScreenshotWindowRect[]).finally(()=>{inFlight=false;});
  try {
   return await Promise.race([result,new Promise<ScreenshotWindowRect[]>(resolve=>{timer=setTimeout(()=>resolve([]),maxWaitMs);})]);
  }finally{clearTimeout(timer);}
 };
}
