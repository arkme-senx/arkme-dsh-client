import {EventEmitter} from 'node:events';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({handlers:new Map<string,Function>(),windows:[] as any[],permission:vi.fn(),guidance:vi.fn(),openSettings:vi.fn(),sources:vi.fn(),save:vi.fn(),write:vi.fn(),scope:'a',blocked:false,allowed:true,displayEvents:new Map<string,Function>(),displays:[] as any[],nativeWindows:[] as any[],nativeRead:vi.fn(),physicalBounds:vi.fn(),load:vi.fn(),construct:vi.fn(),clipboard:vi.fn()}));
vi.mock('../src/native-screenshot-windows.js',()=>({createScreenshotWindowReader:()=>mocks.nativeRead}));
vi.mock('node:fs/promises',()=>({writeFile:mocks.write}));
vi.mock('electron',async()=>{
 const {EventEmitter}=await import('node:events');let id=1;
 class Window extends EventEmitter {
  destroyed=false;visible=true;webContents:any;options:any;
  constructor(options:any={}) {super();mocks.construct();this.options=options;const contents:any=new EventEmitter();contents.id=id++;contents.mainFrame={url:'http://localhost:1234/'};contents.getURL=()=>contents.mainFrame.url;contents.session={};contents.send=vi.fn();contents.setWindowOpenHandler=()=>{};this.webContents=contents;mocks.windows.push(this)}
  static fromWebContents(c:any){return mocks.windows.find(w=>w.webContents===c)}
  isMinimized(){return false} restore(){} isDestroyed(){return this.destroyed} isVisible(){return this.visible} hide(){this.visible=false} show(){this.visible=true} focus=vi.fn(); showInactive(){this.visible=true}
  setAlwaysOnTop(){} workspaceOptions:any; setVisibleOnAllWorkspaces(_visible:boolean,options:any){this.workspaceOptions=options} getBounds(){return this.options}
  async loadURL(url:string){this.webContents.mainFrame.url=url;this.visible=false;await mocks.load(this)}
  destroy(){this.destroyed=true;this.emit('closed')}
 }
 return {session:{fromPartition:()=>({setPermissionRequestHandler:()=>{},setPermissionCheckHandler:()=>{}})},app:{getName:()=>'即我',on:vi.fn()},systemPreferences:{getMediaAccessStatus:mocks.permission},shell:{openExternal:mocks.openSettings},BrowserWindow:Window,ipcMain:{handle:(k:string,v:Function)=>mocks.handlers.set(k,v)},desktopCapturer:{getSources:mocks.sources},dialog:{showSaveDialog:mocks.save,showMessageBox:mocks.guidance},
 clipboard:{writeImage:mocks.clipboard},nativeImage:{createFromBuffer:(bytes:Buffer)=>({isEmpty:()=>false,toPNG:()=>bytes})},screen:{on:(k:string,v:Function)=>mocks.displayEvents.set(k,v),
 dipToScreenRect:mocks.physicalBounds,getAllDisplays:()=>mocks.displays,getCursorScreenPoint:()=>({x:0,y:0}),getDisplayNearestPoint:()=>({id:10}),getDisplayMatching:()=>({id:10})}};
});
import {BrowserWindow} from 'electron';
import {installScreenshotIpc} from '../src/desktop-screenshot-ipc.js';
let owner:any, controller:ReturnType<typeof installScreenshotIpc>;
const event=(window:any,frame?:any)=>({sender:window.webContents,senderFrame:frame??window.webContents.mainFrame});
const call=(name:string,e:any,...args:any[])=>mocks.handlers.get('arkme-screenshot:'+name)!(e,...args);
const png=()=>{const b=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(100,16);b.writeUInt32BE(50,20);return b.toString('base64')};
beforeEach(()=>{vi.useFakeTimers();mocks.permission.mockReset().mockReturnValue('granted');mocks.guidance.mockReset().mockResolvedValue({response:0});mocks.openSettings.mockReset().mockResolvedValue(undefined);mocks.handlers.clear();mocks.clipboard.mockReset();mocks.windows.length=0;mocks.scope='a';mocks.blocked=false;mocks.allowed=true;mocks.construct.mockReset();mocks.load.mockReset();mocks.nativeWindows=[];mocks.nativeRead.mockReset().mockImplementation(async()=>mocks.nativeWindows);mocks.physicalBounds.mockImplementation((_window:any,bounds:any)=>bounds);mocks.write.mockReset();mocks.save.mockReset();mocks.sources.mockReset();
 mocks.displays=[{id:10,bounds:{x:-800,y:0,width:800,height:600},size:{width:800,height:600},scaleFactor:2}];
 owner=new BrowserWindow();mocks.sources.mockResolvedValue([{display_id:'10',thumbnail:{isEmpty:()=>false,getSize:()=>({width:1600,height:1200}),toPNG:()=>Buffer.from('frame')}}]);
 controller=installScreenshotIpc({blocked:()=>mocks.blocked,main:()=>owner,origin:()=> 'http://localhost:1234',scope:()=>mocks.scope,preload:()=>'/preload',editorPreload:()=>'/screenshot-preload',allowed:id=>mocks.allowed && id===owner.webContents.id});
});
afterEach(()=>{for(const w of mocks.windows)if(!w.destroyed)w.destroy();vi.useRealTimers();vi.unstubAllGlobals()});
async function start(){const result=call('capture',event(owner),'request');await vi.advanceTimersByTimeAsync(200);return {result,child:mocks.windows[1]}}
it.each(['not-determined','denied','restricted'])('guides missing screen permission (%s) without capturing',async status=>{
 vi.stubGlobal('process',{...process,platform:'darwin'});mocks.permission.mockReturnValue(status);
 const {result}=await start();await expect(result).resolves.toEqual({status:'cancelled'});
 expect(mocks.guidance).toHaveBeenCalledWith(expect.objectContaining({message:'需要开启录屏权限',buttons:['暂不开启','打开系统设置'],cancelId:0}));
 expect(mocks.guidance.mock.calls[0]![0].detail).toContain('允许“即我”录制屏幕');
 expect(mocks.sources).not.toHaveBeenCalled();expect(mocks.windows).toHaveLength(1);expect(mocks.openSettings).not.toHaveBeenCalled();
});
it('opens screen recording settings for the global clipboard shortcut without a second error',async()=>{
 vi.stubGlobal('process',{...process,platform:'darwin'});mocks.permission.mockReturnValue('denied');mocks.guidance.mockResolvedValue({response:1});
 await controller.captureClipboard(owner);
 expect(mocks.openSettings).toHaveBeenCalledExactlyOnceWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
 expect(mocks.clipboard).not.toHaveBeenCalled();expect(mocks.sources).not.toHaveBeenCalled();
});
it('keeps one permission prompt active, allows reading it beyond the capture timeout and retries after permission is granted',async()=>{
 vi.stubGlobal('process',{...process,platform:'darwin'});mocks.permission.mockReturnValue('denied');
 let resolve!:Function;mocks.guidance.mockReturnValue(new Promise(r=>resolve=r));
 const {result}=await start();await vi.advanceTimersByTimeAsync(30_000);
 await expect(call('capture',event(owner),'other')).rejects.toThrow('正在截屏');expect(mocks.guidance).toHaveBeenCalledOnce();
 resolve({response:0});await expect(result).resolves.toEqual({status:'cancelled'});
 mocks.permission.mockReturnValue('granted');const next=await start();expect(next.child).toBeDefined();
 call('close',event(next.child));await next.result;
});
it('does not open settings after the requesting account changes',async()=>{
 vi.stubGlobal('process',{...process,platform:'darwin'});mocks.permission.mockReturnValue('denied');
 let resolve!:Function;mocks.guidance.mockReturnValue(new Promise(r=>resolve=r));
 const {result}=await start();mocks.scope='changed';resolve({response:1});
 await expect(result).resolves.toEqual({status:'cancelled'});expect(mocks.openSettings).not.toHaveBeenCalled();
});
it('provides the manual settings path when opening settings fails',async()=>{
 vi.stubGlobal('process',{...process,platform:'darwin'});mocks.permission.mockReturnValue('denied');mocks.guidance.mockResolvedValue({response:1});
 mocks.openSettings.mockRejectedValue(new Error('OS error'));
 await expect(call('capture',event(owner),'request')).rejects.toThrow('请手动前往系统设置 → 隐私与安全性 → 录屏与系统录音');
});
it('rechecks permissions when screen capture fails after the initial permission check',async()=>{
 vi.stubGlobal('process',{...process,platform:'darwin'});mocks.permission.mockReturnValueOnce('granted').mockReturnValue('denied');
 mocks.sources.mockRejectedValue(new Error('capture failed'));
 const {result}=await start();await expect(result).resolves.toEqual({status:'cancelled'});expect(mocks.guidance).toHaveBeenCalledOnce();
});
it('preserves unrelated capture failures when screen permission is granted',async()=>{
 mocks.sources.mockRejectedValue(new Error('capture device unavailable'));
 await expect(call('capture',event(owner),'request')).rejects.toThrow('capture device unavailable');
 expect(mocks.guidance).not.toHaveBeenCalled();
});
it('does not use macOS permission checks on Windows',async()=>{
 vi.stubGlobal('process',{...process,platform:'win32'});mocks.permission.mockReturnValue('denied');
 const {result,child}=await start();expect(mocks.permission).not.toHaveBeenCalled();expect(mocks.guidance).not.toHaveBeenCalled();
 call('close',event(child));await result;
});
it('keeps opener visible, captures physical pixels and returns only the editor result',async()=>{
 const {result,child}=await start();expect(owner.visible).toBe(true);
 expect(mocks.sources).toHaveBeenCalledWith({types:['screen'],thumbnailSize:{width:1600,height:1200}});
 expect(call('context',event(owner))).toBeNull();expect(call('context',event(child))).toMatchObject({width:1600,height:1200});
 expect(child.options.x).toBe(-800);call('ready',event(child));expect(child.visible).toBe(true);
 call('select',event(child));expect(call('complete',event(child),png())).toBe(true);
 await expect(result).resolves.toMatchObject({status:'captured',mimeType:'image/png'});expect(owner.visible).toBe(true);expect(child.destroyed).toBe(true);expect(mocks.clipboard).not.toHaveBeenCalled();
});
it('rejects subframes and unrelated windows',async()=>{
 await expect(call('capture',event(owner,{url:'http://localhost:1234/'}),'request')).rejects.toThrow('来源');
 const foreign=new BrowserWindow();await expect(call('capture',event(foreign),'request')).rejects.toThrow('来源');
});
it('rejects overlapping captures and only cancels matching owner requests',async()=>{
 const {result,child}=await start();await expect(call('capture',event(owner),'other')).rejects.toThrow('正在截屏');
 call('cancel',event(owner),'old');expect(child.destroyed).toBe(false);call('cancel',event(owner),'request');
 await expect(result).resolves.toEqual({status:'cancelled'});
});
it('discards pending capture after cancellation without creating windows',async()=>{
 let resolve!:Function;mocks.sources.mockReturnValue(new Promise(r=>resolve=r));const result=call('capture',event(owner),'request');await vi.advanceTimersByTimeAsync(200);
 call('cancel',event(owner),'request');resolve([]);await vi.advanceTimersByTimeAsync(1);
 expect(mocks.windows).toHaveLength(1);await expect(result).resolves.toEqual({status:'cancelled'});
});
it.each(['scope','navigation','display','display-added'])('cleans up on %s invalidation',async(kind)=>{
 const {result,child}=await start();if(kind==='scope'){mocks.scope='b';await vi.advanceTimersByTimeAsync(250)}
 else if(kind==='navigation')owner.webContents.emit('did-start-navigation');else mocks.displayEvents.get(kind==='display-added'?'display-added':'display-removed')!();
 await expect(result).resolves.toEqual({status:'cancelled'});expect(child.destroyed).toBe(true);expect(call('context',event(child))).toBeNull();
});
it('cancelled save does not close the editor or write a file',async()=>{
 const {result,child}=await start();mocks.save.mockResolvedValue({canceled:true});expect(await call('save',event(child),png())).toBe(false);
 expect(mocks.write).not.toHaveBeenCalled();expect(child.destroyed).toBe(false);call('close',event(child));await result;
});
it('scope change while save dialog is open never writes',async()=>{
 const {result,child}=await start();let resolve!:Function;mocks.save.mockReturnValue(new Promise(r=>resolve=r));
 const save=call('save',event(child),png());mocks.scope='b';resolve({canceled:false,filePath:'/tmp/should-not-write.png'});
 expect(await save).toBe(false);expect(mocks.write).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(250);await result;
});
it('rejects invalid PNG and leaves the editor open for retry',async()=>{
 const {result,child}=await start();expect(()=>call('complete',event(child),'garbage')).toThrow();expect(child.destroyed).toBe(false);call('close',event(child));await result;
});

it('keeps the macOS app process type unchanged when showing screenshot overlays',async()=>{
 const {result,child}=await start();
 expect(child.workspaceOptions).toEqual({visibleOnFullScreen:true,skipTransformProcessType:true});
 call('close',event(child));await expect(result).resolves.toEqual({status:'cancelled'});
 expect(owner.visible).toBe(true);
});

it('requests each display at its own physical size without upsampling the smaller screen',async()=>{
 mocks.displays=[
  {id:10,bounds:{x:0,y:0,width:1512,height:982},size:{width:1512,height:982},scaleFactor:2},
  {id:20,bounds:{x:0,y:-1080,width:1920,height:1080},size:{width:1920,height:1080},scaleFactor:2},
 ];
 mocks.sources.mockImplementation(async({thumbnailSize}:any)=>mocks.displays.map(d=>{
  const scale=Math.min(thumbnailSize.width/d.size.width,thumbnailSize.height/d.size.height);
  return {display_id:String(d.id),thumbnail:{isEmpty:()=>false,getSize:()=>({width:Math.floor(d.size.width*scale),height:Math.floor(d.size.height*scale)}),toPNG:()=>Buffer.from('frame')}};
 }));
 const {result}=await start();
 expect(mocks.sources.mock.calls.map(([options])=>options.thumbnailSize)).toEqual([{width:3024,height:1964},{width:3840,height:2160}]);
 expect(call('context',event(mocks.windows[1]))).toMatchObject({width:3024,height:1964});
 expect(call('context',event(mocks.windows[2]))).toMatchObject({width:3840,height:2160});
 call('ready',event(mocks.windows[1]));expect(mocks.windows[1].visible).toBe(false);
 call('ready',event(mocks.windows[2]));expect(mocks.windows[1].visible).toBe(true);
 call('close',event(mocks.windows[1]));await result;
});

it('uses a macOS panel and never reactivates the opener when the screenshot closes',async()=>{
 const {result,child}=await start();
 expect(child.options.type).toBe(process.platform==='darwin' ? 'panel' : undefined);
 call('ready',event(child));expect(child.focus).toHaveBeenCalledOnce();
 call('close',event(child));await result;
 if(process.platform==='darwin') expect(owner.focus).not.toHaveBeenCalled();
});

it('includes only display-local window rectangles in the scoped editor context',async()=>{
 mocks.nativeWindows=[{x:-700,y:100,width:400,height:300},{x:20,y:20,width:200,height:200}];
 const {result,child}=await start();
 expect(call('context',event(child)).windows).toEqual([{x:200,y:200,width:800,height:600}]);
 expect(call('context',event(owner))).toBeNull();
 call('close',event(child));await result;
});

it('converts Windows display DIP bounds before mapping native physical window bounds',async()=>{
 vi.stubGlobal('process',{...process,platform:'win32'});
 mocks.physicalBounds.mockReturnValue({x:-1600,y:0,width:1600,height:1200});
 mocks.nativeWindows=[{x:-1400,y:200,width:800,height:600}];
 const {result,child}=await start();
 expect(call('context',event(child)).windows).toEqual([{x:200,y:200,width:800,height:600}]);
 call('close',event(child));await result;
});

it('starts different-size screen captures together and keeps overlays hidden until every frame is ready',async()=>{
 mocks.displays.push({id:20,bounds:{x:0,y:0,width:1000,height:700},size:{width:1000,height:700},scaleFactor:2});
 const pending:Function[]=[];mocks.sources.mockImplementation(()=>new Promise(r=>pending.push(r)));
 const result=call('capture',event(owner),'request');await vi.advanceTimersByTimeAsync(1);
 try {expect(pending).toHaveLength(2);} finally {call('cancel',event(owner),'request');await result;pending.forEach(r=>r([]));await vi.advanceTimersByTimeAsync(1);}
 expect(mocks.windows).toHaveLength(1);
});
it('loads both editor windows without waiting for the first navigation',async()=>{
 mocks.displays.push({id:20,bounds:{x:0,y:0,width:1000,height:700},size:{width:1000,height:700},scaleFactor:2});
 mocks.sources.mockResolvedValue([10,20].map(id=>({display_id:String(id),thumbnail:{isEmpty:()=>false,getSize:()=>({width:1600,height:1200}),toPNG:()=>Buffer.from('frame')}})));
 const pending:Function[]=[];mocks.load.mockImplementation(()=>new Promise(r=>pending.push(r)));
 const result=call('capture',event(owner),'request');await vi.advanceTimersByTimeAsync(1);
 try {expect(pending).toHaveLength(2);expect(mocks.windows.slice(1).every(w=>!w.visible)).toBe(true);} finally {call('cancel',event(owner),'request');await result;pending.forEach(r=>r());await vi.advanceTimersByTimeAsync(1);}
});

it('handles pending navigation rejection when a later overlay fails to initialize',async()=>{
 mocks.displays.push({id:20,bounds:{x:0,y:0,width:1000,height:700},size:{width:1000,height:700},scaleFactor:2});
 mocks.sources.mockResolvedValue([10,20].map(id=>({display_id:String(id),thumbnail:{isEmpty:()=>false,getSize:()=>({width:1600,height:1200}),toPNG:()=>Buffer.from('frame')}})));
 mocks.construct.mockImplementationOnce(()=>{}).mockImplementationOnce(()=>{throw new Error('overlay init failed');});
 mocks.load.mockImplementation((window:any)=>new Promise((_resolve,reject)=>window.once('closed',()=>reject(new Error('load aborted')))));
 const result=call('capture',event(owner),'request');const failed=expect(result).rejects.toThrow('overlay init failed');
 await vi.advanceTimersByTimeAsync(1);await failed;
 expect(mocks.windows[1].destroyed).toBe(true);
});

it('blocks every capture while shortcut recording is active and resumes afterward',async()=>{
 mocks.blocked=true;await expect(call('capture',event(owner),'request')).rejects.toThrow('设置截图快捷键');expect(mocks.sources).not.toHaveBeenCalled();
 mocks.blocked=false;const {result}=await start();expect(mocks.sources).toHaveBeenCalled();call('cancel',event(owner),'request');await result;
});

// No renderer listener or conversation composer exists in these shortcut captures.
it.each(['recordings','chat','settings','minimized'])('copies shortcut results independently of the %s page',async page=>{
 owner.webContents.mainFrame.url='http://localhost:1234/?page='+page;
 if(page==='minimized')owner.visible=false;
 const result=controller.captureClipboard(owner);await vi.advanceTimersByTimeAsync(200);
 const child=mocks.windows[1];expect(child).toBeDefined();
 expect(call('complete',event(child),png())).toBe(true);await result;
 expect(mocks.clipboard).toHaveBeenCalledOnce();
 expect(mocks.clipboard.mock.calls[0]![0].toPNG().toString('base64')).toBe(png());
 expect(owner.focus).not.toHaveBeenCalled();expect(child.destroyed).toBe(true);
});
it('does not replace the clipboard on shortcut cancellation or account invalidation',async()=>{
 for(const invalidate of [false,true]){
  const result=controller.captureClipboard(owner);await vi.advanceTimersByTimeAsync(200);
  const child=mocks.windows.at(-1);
  if(invalidate){mocks.scope='changed';expect(call('complete',event(child),png())).toBe(false);await vi.advanceTimersByTimeAsync(250);}
  else call('close',event(child));
  await result;expect(mocks.clipboard).not.toHaveBeenCalled();
 }
});
it('keeps a failed clipboard completion open for retry',async()=>{
 const result=controller.captureClipboard(owner);await vi.advanceTimersByTimeAsync(200);const child=mocks.windows[1];
 mocks.clipboard.mockImplementationOnce(()=>{throw new Error('clipboard unavailable')});
 expect(()=>call('complete',event(child),png())).toThrow('clipboard unavailable');expect(child.destroyed).toBe(false);
 expect(call('complete',event(child),png())).toBe(true);await result;expect(child.destroyed).toBe(true);
});
it('ignores repeated global triggers while an attachment capture is active',async()=>{
 const {result,child}=await start();await controller.captureClipboard(owner);
 expect(mocks.windows).toHaveLength(2);call('complete',event(child),png());await expect(result).resolves.toMatchObject({status:'captured'});
 expect(mocks.clipboard).not.toHaveBeenCalled();
});
it('blocks shortcut capture while editing shortcuts and rejects foreign origins',async()=>{
 mocks.blocked=true;await expect(controller.captureClipboard(owner)).rejects.toThrow('设置截图快捷键');
 mocks.blocked=false;owner.webContents.mainFrame.url='https://evil.test/';
 await expect(controller.captureClipboard(owner)).rejects.toThrow('来源');expect(mocks.sources).not.toHaveBeenCalled();
});

it('never copies a completion after its owner loses permission, even before the watchdog runs',async()=>{
 const result=controller.captureClipboard(owner);await vi.advanceTimersByTimeAsync(200);const child=mocks.windows[1];
 mocks.allowed=false;expect(call('complete',event(child),png())).toBe(false);expect(mocks.clipboard).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(250);await result;
});

it('hands edited PNG to the main DSH surface and closes only after its acknowledgement',async()=>{
 const {result,child}=await start();
 const ask=call('ask-dsh',event(child),png());await Promise.resolve();
 const [channel,payload]=owner.webContents.send.mock.calls.at(-1)!;
 expect(channel).toBe('arkme-screenshot:ask-dsh-request');expect(payload.contentBase64).toBe(png());expect(child.destroyed).toBe(false);
 expect(call('ask-dsh-result',event(child),{requestId:payload.requestId,ok:true})).toBe(false);
 expect(call('ask-dsh-result',event(owner),{requestId:payload.requestId,ok:true})).toBe(true);
 await expect(ask).resolves.toBe(true);await expect(result).resolves.toEqual({status:'cancelled'});
 expect(owner.webContents.send).toHaveBeenLastCalledWith('arkme-screenshot:ask-dsh-activate',{requestId:payload.requestId});
 expect(mocks.clipboard).not.toHaveBeenCalled();expect(child.destroyed).toBe(true);
});
it('keeps the editor after DSH preparation fails and reuses the operation on retry',async()=>{
 const {result,child}=await start();
 const ask=call('ask-dsh',event(child),png());const failed=expect(ask).rejects.toThrow('附件失败');await Promise.resolve();
 const first=owner.webContents.send.mock.calls.at(-1)![1];
 call('ask-dsh-result',event(owner),{requestId:first.requestId,ok:false,error:'附件失败'});await failed;expect(child.destroyed).toBe(false);
 const retry=call('ask-dsh',event(child),png());await Promise.resolve();const second=owner.webContents.send.mock.calls.at(-1)![1];
 expect(second.operationId).toBe(first.operationId);expect(second.requestId).not.toBe(first.requestId);
 call('ask-dsh-result',event(owner),{requestId:second.requestId,ok:true});await retry;await result;
});
it('cancels pending DSH work on scope invalidation and rejects late replies',async()=>{
 const {result,child}=await start();const ask=call('ask-dsh',event(child),png());const rejected=expect(ask).rejects.toThrow();await Promise.resolve();
 const payload=owner.webContents.send.mock.calls.at(-1)![1];mocks.scope='other';await vi.advanceTimersByTimeAsync(250);await rejected;await result;
 expect(call('ask-dsh-result',event(owner),{requestId:payload.requestId,ok:true})).toBe(false);
 expect(owner.webContents.send).toHaveBeenCalledWith('arkme-screenshot:ask-dsh-cancel',{requestId:payload.requestId});
});
it('does not dispatch invalid PNG or overlapping DSH requests',async()=>{
 const {result,child}=await start();await expect(call('ask-dsh',event(child),'invalid')).rejects.toThrow();expect(owner.webContents.send).not.toHaveBeenCalled();
 const ask=call('ask-dsh',event(child),png());await Promise.resolve();await expect(call('ask-dsh',event(child),png())).resolves.toBe(false);
 const payload=owner.webContents.send.mock.calls.at(-1)![1];call('ask-dsh-result',event(owner),{requestId:payload.requestId,ok:true});await ask;await result;
});

it('logs only authorized diagnostic stages when explicitly enabled',async()=>{
 vi.stubEnv('ARKME_SCREENSHOT_PROFILE','1');
 const info=vi.spyOn(console,'info').mockImplementation(()=>{});
 try{
  const started=await start();const child=mocks.windows.at(-1);
  await call('context',event(child));
  await call('profile',event(owner),'image-decoded');
  await call('profile',event(child),'arbitrary-sensitive-data');
  await call('profile',event(child),'image-decoded');
  const records=info.mock.calls.filter(args=>args[0]==='[arkme-screenshot-profile]').map(args=>JSON.parse(args[1] as string));
  expect(records.filter(r=>r.stage==='image-decoded')).toHaveLength(1);
  expect(records.some(r=>r.stage==='arbitrary-sensitive-data')).toBe(false);
  expect(records.some(r=>r.stage==='context-request')).toBe(true);
  expect(records.every(r=>Object.keys(r).every(k=>['requestId','stage','elapsedMs','windowId'].includes(k)))).toBe(true);
  await call('close',event(child));await started.result;
 }finally{info.mockRestore();vi.unstubAllEnvs();}
});

it('keeps screenshot diagnostics disabled by default',async()=>{
 vi.stubEnv('ARKME_SCREENSHOT_PROFILE','');
 const info=vi.spyOn(console,'info').mockImplementation(()=>{});
 try{
  const started=await start();const child=mocks.windows.at(-1);
  expect(await call('context',event(child))).not.toHaveProperty('profileEnabled');
  await call('profile',event(child),'image-decoded');
  await call('close',event(child));await started.result;
  expect(info).not.toHaveBeenCalled();
 }finally{info.mockRestore();vi.unstubAllEnvs();}
});

it('loads the standalone page with its dedicated preload when the runtime advertises support',async()=>{
 expect(await call('enable-standalone',event(owner))).toBe(true);
 const {result,child}=await start();
 expect(child.webContents.mainFrame.url).toBe('http://localhost:1234/arkme-self/screenshot?arkmeScreenshot=1');
 expect(child.options.webPreferences.preload).toBe('/screenshot-preload');
 expect(await call('context',event(child))).toHaveProperty('contentBase64');
 await call('ready',event(child));expect(child.visible).toBe(true);
 await call('close',event(child));await result;
});
it('keeps the old document and preload for older plugin versions',async()=>{
 const {result,child}=await start();
 expect(child.webContents.mainFrame.url).toBe('http://localhost:1234/?arkmeScreenshot=1');
 expect(child.options.webPreferences.preload).toBe('/preload');
 await call('close',event(child));await result;
});

it('accepts standalone registration only from the main window top frame',async()=>{
 const {result,child}=await start();
 expect(await call('enable-standalone',event(child))).toBe(false);
 const nested=event(owner);nested.senderFrame={url:'http://localhost:1234/'};
 expect(await call('enable-standalone',nested)).toBe(false);
 const foreign=event(owner);foreign.senderFrame={url:'https://example.com/'};
 expect(await call('enable-standalone',foreign)).toBe(false);
 await call('close',event(child));await result;
});

it('preloads a blank editor without capturing and hands pixels to it only during an authorized capture',async()=>{
 await call('enable-standalone',event(owner));
 await vi.advanceTimersByTimeAsync(100);
 const warm=mocks.windows[1];
 expect(warm.visible).toBe(false);expect(mocks.sources).not.toHaveBeenCalled();
 let received=false;
 const pending=call('context',event(warm)).then((value:any)=>{received=true;return value});
 await Promise.resolve();expect(received).toBe(false);
 expect(call('ready',event(warm))).toBe(false);
 const result=call('capture',event(owner),'warm-request');
 await vi.advanceTimersByTimeAsync(1);
 expect(await pending).toMatchObject({contentBase64:Buffer.from('frame').toString('base64')});
 expect(mocks.windows).toHaveLength(2);expect(mocks.load).toHaveBeenCalledTimes(1);
 call('ready',event(warm));expect(warm.visible).toBe(true);
 call('close',event(warm));await result;expect(warm.destroyed).toBe(true);
 await vi.advanceTimersByTimeAsync(100);
 expect(mocks.windows).toHaveLength(3);expect(mocks.windows[2].visible).toBe(false);
 expect(call('context',event(warm))).toBeNull();
});
it('drops blank editors and pending context on main navigation',async()=>{
 await call('enable-standalone',event(owner));await vi.advanceTimersByTimeAsync(100);
 const warm=mocks.windows[1],pending=call('context',event(warm));
 owner.webContents.emit('did-start-navigation');
 expect(await pending).toBeNull();expect(warm.destroyed).toBe(true);
 await vi.advanceTimersByTimeAsync(200);expect(mocks.windows).toHaveLength(2);
});
it('discards a warm editor after display geometry changes and never exposes pixels to a subframe',async()=>{
 await call('enable-standalone',event(owner));await vi.advanceTimersByTimeAsync(100);
 const warm=mocks.windows[1];
 expect(call('context',event(warm,{url:warm.webContents.getURL()}))).toBeNull();
 const pending=call('context',event(warm));
 mocks.displayEvents.get('display-metrics-changed')!();
 expect(await pending).toBeNull();expect(warm.destroyed).toBe(true);
 await vi.advanceTimersByTimeAsync(100);expect(mocks.windows).toHaveLength(3);
});

it('keeps prewarming across SPA conversation navigation and child frame navigation',async()=>{
 await call('enable-standalone',event(owner));
 owner.webContents.emit('did-start-navigation',{isSameDocument:true,isMainFrame:true});
 owner.webContents.emit('did-start-navigation',{isSameDocument:false,isMainFrame:false});
 await vi.advanceTimersByTimeAsync(100);
 const warm=mocks.windows[1];expect(warm.destroyed).toBe(false);
 const {result,child}=await start();expect(child).toBe(warm);
 expect(child.webContents.getURL()).toContain('/arkme-self/screenshot');
 call('close',event(child));await result;
});

it('reuses a reset-capable renderer across rapid captures and rejects every stale-session operation',async()=>{
 await call('enable-standalone',event(owner),'reset-v1');await vi.advanceTimersByTimeAsync(100);
 const child=mocks.windows[1];
 for(let i=0;i<5;i++) {
  const token=`reuse-${i}`,result=call('capture',event(owner),token);
  await vi.advanceTimersByTimeAsync(1);
  expect(await call('context',event(child))).toHaveProperty('requestId',token);
  expect(call('ready',event(child),'previous')).toBe(false);
  expect(call('select',event(child),'previous')).toBe(false);
  expect(call('complete',event(child),png(),'previous')).toBe(false);
  expect(await call('save',event(child),png(),'previous')).toBe(false);
  expect(await call('ask-dsh',event(child),png(),'previous')).toBe(false);
  call('close',event(child),'previous');expect(child.destroyed).toBe(false);
  expect(call('ready',event(child),token)).toBe(true);
  call('close',event(child),token);await result;
  expect(child.visible).toBe(false);expect(child.destroyed).toBe(false);
 }
 expect(mocks.load).toHaveBeenCalledTimes(1);expect(mocks.windows).toHaveLength(2);
 expect(child.webContents.send).toHaveBeenCalledTimes(5);
 expect(child.webContents.send).toHaveBeenLastCalledWith('arkme-screenshot:reset');
 expect(child.webContents.listenerCount('render-process-gone')).toBe(1);
});
it('destroys a reusable editor on account invalidation rather than retaining its frame',async()=>{
 await call('enable-standalone',event(owner),'reset-v1');await vi.advanceTimersByTimeAsync(100);
 const child=mocks.windows[1],result=call('capture',event(owner),'scope-reuse');await vi.advanceTimersByTimeAsync(1);
 mocks.scope='other';await vi.advanceTimersByTimeAsync(250);
 await expect(result).resolves.toEqual({status:'cancelled'});expect(child.destroyed).toBe(true);
 expect(child.webContents.send).not.toHaveBeenCalled();
});

it.each(['complete','close'])('reuses both dual-screen editors after selection hides the other native window (%s)',async action=>{
 mocks.displays.push({id:20,bounds:{x:0,y:0,width:1000,height:700},size:{width:1000,height:700},scaleFactor:2});
 mocks.sources.mockResolvedValue([10,20].map(id=>({display_id:String(id),thumbnail:{isEmpty:()=>false,getSize:()=>({width:1600,height:1200}),toPNG:()=>Buffer.from('frame')}})));
 await call('enable-standalone',event(owner),'reset-v1');await vi.advanceTimersByTimeAsync(100);
 const child=mocks.windows[1],other=mocks.windows[2],contents=other.webContents;
 Object.defineProperty(other,'webContents',{get(){if(other.destroyed)throw new Error('Object has been destroyed');return contents;}});
 const result=call('capture',event(owner),'selected-request');await vi.advanceTimersByTimeAsync(1);
 expect(call('select',event(child),'selected-request')).toBe(true);expect(other.destroyed).toBe(false);expect(other.visible).toBe(false);
 expect(call('context',event(other))).toBeNull();
 expect(call('ready',event(other),'selected-request')).toBe(false);
 expect(call('complete',event(other),png(),'selected-request')).toBe(false);
 if(action==='complete')expect(call('complete',event(child),png(),'selected-request')).toBe(true);
 else call('close',event(child),'selected-request');
 await expect(result).resolves.toMatchObject({status:action==='complete'?'captured':'cancelled'});
 expect(child.visible).toBe(false);
 const next=call('capture',event(owner),'next-selected');await vi.advanceTimersByTimeAsync(1);
 expect(call('ready',event(child),'selected-request')).toBe(false);
 expect(call('context',event(other))).toHaveProperty('requestId','next-selected');
 expect(mocks.windows).toHaveLength(3);expect(mocks.load).toHaveBeenCalledTimes(2);
 call('close',event(child),'next-selected');await expect(next).resolves.toEqual({status:'cancelled'});
});

it('releases per-capture load listeners after repeated reusable captures',async()=>{
 await call('enable-standalone',event(owner),'reset-v1');await vi.advanceTimersByTimeAsync(100);
 const child=mocks.windows[1];
 for(let i=0;i<30;i++) {
  const token=`listener-${i}`,result=call('capture',event(owner),token);
  await vi.advanceTimersByTimeAsync(1);
  call('ready',event(child),token);call('close',event(child),token);
  await expect(result).resolves.toEqual({status:'cancelled'});
  expect(child.webContents.listenerCount('dom-ready')).toBe(0);
  expect(child.webContents.listenerCount('did-finish-load')).toBe(0);
 }
 expect(mocks.windows).toHaveLength(2);
});

it('captures pixels while native window enumeration is pending, and discards cancelled results',async()=>{
 let resolve!:(value:any[])=>void;
 mocks.nativeRead.mockReturnValue(new Promise<any[]>(done=>{resolve=done}));
 const result=call('capture',event(owner),'slow-native');
 await vi.advanceTimersByTimeAsync(1);
 expect(mocks.sources).toHaveBeenCalledTimes(1);
 expect(mocks.windows).toHaveLength(1);
 call('cancel',event(owner),'slow-native');
 await expect(result).resolves.toEqual({status:'cancelled'});
 resolve([{x:0,y:0,width:100,height:100}]);await vi.advanceTimersByTimeAsync(1);
 expect(mocks.windows).toHaveLength(1);
});
it('removes unfinished load tracing when a new capture is cancelled before loading completes',async()=>{
 let loaded!:()=>void;mocks.load.mockReturnValue(new Promise<void>(done=>{loaded=done}));
 const result=call('capture',event(owner),'cancel-loading');await vi.advanceTimersByTimeAsync(1);
 const child=mocks.windows[1],contents=child.webContents;
 call('cancel',event(owner),'cancel-loading');await expect(result).resolves.toEqual({status:'cancelled'});
 expect(contents.listenerCount('dom-ready')).toBe(0);
 expect(contents.listenerCount('did-finish-load')).toBe(0);
 loaded();await vi.advanceTimersByTimeAsync(1);
 expect(child.destroyed).toBe(true);
});

it.each([true,false])('isolates standalone editor connections on warm and cold creation (warm=%s)',async warm=>{
 await call('enable-standalone',event(owner),'reset-v1');
 if(warm)await vi.advanceTimersByTimeAsync(100);
 const result=call('capture',event(owner),'isolated');await vi.advanceTimersByTimeAsync(1);
 const child=mocks.windows[1];
 expect(child.options.webPreferences.session).not.toBe(owner.webContents.session);
 call('close',event(child),'isolated');await result;
});
it('retires hidden peer editors on account invalidation',async()=>{
 mocks.displays.push({id:20,bounds:{x:0,y:0,width:1000,height:700},size:{width:1000,height:700},scaleFactor:2});
 mocks.sources.mockResolvedValue([10,20].map(id=>({display_id:String(id),thumbnail:{isEmpty:()=>false,getSize:()=>({width:1600,height:1200}),toPNG:()=>Buffer.from('frame')}})));
 await call('enable-standalone',event(owner),'reset-v1');await vi.advanceTimersByTimeAsync(100);
 const result=call('capture',event(owner),'invalidate-peers');await vi.advanceTimersByTimeAsync(1);
 const child=mocks.windows[1],other=mocks.windows[2];
 call('select',event(child),'invalidate-peers');expect(other.destroyed).toBe(false);
 mocks.scope='different';await vi.advanceTimersByTimeAsync(250);await result;
 expect(child.destroyed).toBe(true);expect(other.destroyed).toBe(true);
});

it('discards a crashed hidden peer without cancelling the selected editor',async()=>{
 mocks.displays.push({id:20,bounds:{x:0,y:0,width:1000,height:700},size:{width:1000,height:700},scaleFactor:2});
 mocks.sources.mockResolvedValue([10,20].map(id=>({display_id:String(id),thumbnail:{isEmpty:()=>false,getSize:()=>({width:1600,height:1200}),toPNG:()=>Buffer.from('frame')}})));
 await call('enable-standalone',event(owner),'reset-v1');await vi.advanceTimersByTimeAsync(100);
 const result=call('capture',event(owner),'peer-crash');await vi.advanceTimersByTimeAsync(1);
 const child=mocks.windows[1],other=mocks.windows[2];
 call('select',event(child),'peer-crash');other.webContents.emit('render-process-gone');
 expect(other.destroyed).toBe(true);
 expect(call('complete',event(child),png(),'peer-crash')).toBe(true);
 await expect(result).resolves.toMatchObject({status:'captured'});
});
