import {readMacScreenshotWindows} from './macos-screenshot-windows.js';
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
