import {createRequire} from 'node:module';
import {validWindowRect,type ScreenshotWindowRect} from './screenshot-window-geometry.js';
type Handle=number|bigint;
export interface WindowsWindowApi {
 enumerate():Handle[]; above(handle:Handle):Handle; visible(handle:Handle):boolean;
 minimized(handle:Handle):boolean; cloaked(handle:Handle):boolean; transparent(handle:Handle):boolean;
 className(handle:Handle):string; bounds(handle:Handle):ScreenshotWindowRect|null;
}
let nativeApi:WindowsWindowApi|undefined;
const shellClasses=new Set(['Progman','WorkerW','Shell_TrayWnd','Shell_SecondaryTrayWnd']);
export function readWindowsScreenshotWindows(api:WindowsWindowApi=nativeApi??=createApi()):ScreenshotWindowRect[] {
 const handles=api.enumerate();
 // EnumWindows snapshots handles safely. Explicit z-order ranks avoid relying on callback order.
 // Bound traversal and detect cycles because external windows can close/reorder during the snapshot.
 const ranks=new Map<string,number>();
 const rank=(h:Handle)=>{
  const seen=new Set<string>();let current=api.above(h),depth=0;
  while(current && depth<4096 && !seen.has(String(current))){seen.add(String(current));depth++;current=api.above(current);}
  return depth;
 };
 const candidates=handles.filter(h=>api.visible(h)&&!api.minimized(h)&&!api.cloaked(h)&&!api.transparent(h)&&!shellClasses.has(api.className(h)));
 for(const h of candidates)ranks.set(String(h),rank(h));
 return candidates.sort((a,b)=>ranks.get(String(a))!-ranks.get(String(b))!).flatMap(h=>{
  const bounds=api.bounds(h);return bounds&&validWindowRect(bounds)?[bounds]:[];
 });
}
function createApi():WindowsWindowApi {
 const koffi=createRequire(import.meta.url)('koffi') as typeof import('koffi').default;
 const user=koffi.load('user32.dll'),dwm=koffi.load('dwmapi.dll');
 const rect=koffi.struct({left:'int32',top:'int32',right:'int32',bottom:'int32'});
 const callback=koffi.proto('int __stdcall ArkmeScreenshotEnumWindow(uintptr_t hwnd, intptr_t data)');
 const enumerate=user.func('int __stdcall EnumWindows(void *callback, intptr_t data)');
 const getWindow=user.func('uintptr_t __stdcall GetWindow(uintptr_t hwnd, uint32 command)');
 const visible=user.func('int __stdcall IsWindowVisible(uintptr_t hwnd)');
 const minimized=user.func('int __stdcall IsIconic(uintptr_t hwnd)');
 const layered=user.func('int __stdcall GetLayeredWindowAttributes(uintptr_t hwnd, _Out_ uint32 *color, _Out_ uint8 *alpha, _Out_ uint32 *flags)');
 const getClass=user.func('int __stdcall GetClassNameW(uintptr_t hwnd, _Out_ uint16 *buffer, int count)');
 const getRect=user.func('__stdcall','GetWindowRect','int',['uintptr_t',koffi.out(koffi.pointer(rect))]);
 const attribute=dwm.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 attribute, void *value, uint32 size)');
 return {
  enumerate:()=>{
   const handles:Handle[]=[];
   const fn=koffi.register((h:Handle)=>{handles.push(h);return 1;},koffi.pointer(callback));
   try{if(!enumerate(fn,0))throw new Error('Cannot enumerate screenshot windows');}finally{koffi.unregister(fn);}
   return handles;
  },
  above:h=>getWindow(h,3), // GW_HWNDPREV
  visible:h=>!!visible(h),minimized:h=>!!minimized(h),
  cloaked:h=>{const value=Buffer.alloc(4);return attribute(h,14,value,4)===0&&value.readUInt32LE()!==0;},
  transparent:h=>{const color=[0],alpha=[255],flags=[0];return !!layered(h,color,alpha,flags)&&!!(flags[0]!&2)&&alpha[0]===0;},
  className:h=>{const value=new Uint16Array(256);const n=getClass(h,value,value.length);return String.fromCharCode(...value.subarray(0,n));},
  bounds:h=>{
   // DWM returns physical pixels without invisible resize margins. Electron is per-monitor DPI aware.
   const value=Buffer.alloc(16);
   if(attribute(h,9,value,16)===0){const left=value.readInt32LE(0),top=value.readInt32LE(4);return {x:left,y:top,width:value.readInt32LE(8)-left,height:value.readInt32LE(12)-top};}
   const fallback={left:0,top:0,right:0,bottom:0};
   return getRect(h,fallback)?{x:fallback.left,y:fallback.top,width:fallback.right-fallback.left,height:fallback.bottom-fallback.top}:null;
  },
 };
}
