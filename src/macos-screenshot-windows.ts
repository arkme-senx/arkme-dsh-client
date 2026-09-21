import {createRequire} from 'node:module';
import {validWindowRect,type ScreenshotWindowRect} from './screenshot-window-geometry.js';
let reader:(()=>ScreenshotWindowRect[])|undefined;
export function readMacScreenshotWindows():ScreenshotWindowRect[] {return (reader??=createReader())();}
function createReader():()=>ScreenshotWindowRect[] {
 const k=createRequire(import.meta.url)('koffi') as typeof import('koffi').default;
 const cg=k.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
 const cf=k.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
 const list=cg.func('void *CGWindowListCopyWindowInfo(uint32 options, uint32 relativeToWindow)');
 const count=cf.func('long CFArrayGetCount(void *array)');
 const at=cf.func('void *CFArrayGetValueAtIndex(void *array, long index)');
 const value=cf.func('void *CFDictionaryGetValue(void *dictionary, void *key)');
 const release=cf.func('void CFRelease(void *value)');
 const number=cf.func('bool CFNumberGetValue(void *number, int type, _Out_ double *value)');
 const typeId=cf.func('ulong CFGetTypeID(void *value)'),numberId=cf.func('ulong CFNumberGetTypeID()');
 const point=k.struct({x:'double',y:'double'}),size=k.struct({width:'double',height:'double'});
 const rect=k.struct({origin:point,size});
 const bounds=cg.func('CGRectMakeWithDictionaryRepresentation','bool',['void *',k.out(k.pointer(rect))]);
 const keys=Object.fromEntries(['kCGWindowBounds','kCGWindowLayer','kCGWindowAlpha'].map(name=>[name,k.decode(cg.symbol(name),'void *')]));
 const readNumber=(dictionary:unknown,key:string,fallback:number)=>{
  const ref=value(dictionary,keys[key]);if(!ref||typeId(ref)!==numberId())return fallback;
  const out=[0];return number(ref,6,out)?out[0]!:fallback; // kCFNumberFloat64Type
 };
 return ()=>{
  // Quartz coordinates have a top-left origin in logical points, matching Electron macOS display bounds.
  // Snapshot before overlay creation, with only on-screen windows and no desktop elements.
  const array=list(1|16,0);if(!array)return [];
  try{
   const result:ScreenshotWindowRect[]=[];
   for(let i=0,n=Math.min(Number(count(array)),4096);i<n;i++){
    const entry=at(array,i),layer=readNumber(entry,'kCGWindowLayer',-1);
    if(layer<0||layer>=20||readNumber(entry,'kCGWindowAlpha',0)<=0)continue;
    const dictionary=value(entry,keys.kCGWindowBounds);if(!dictionary)continue;
    const out={origin:{x:0,y:0},size:{width:0,height:0}};
    if(bounds(dictionary,out)){
     const r={...out.origin,...out.size};if(validWindowRect(r))result.push(r);
    }
   }
   return result;
  }finally{release(array);}
 };
}
