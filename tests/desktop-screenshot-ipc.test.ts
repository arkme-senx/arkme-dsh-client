import {EventEmitter} from 'node:events';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({handlers:new Map<string,Function>(),windows:[] as any[],sources:vi.fn(),save:vi.fn(),write:vi.fn(),scope:'a',blocked:false,allowed:true,displayEvents:new Map<string,Function>(),displays:[] as any[],nativeWindows:[] as any[],physicalBounds:vi.fn(),load:vi.fn(),construct:vi.fn(),clipboard:vi.fn()}));
vi.mock('../src/native-screenshot-windows.js',()=>({readScreenshotWindows:()=>mocks.nativeWindows}));
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
 return {BrowserWindow:Window,ipcMain:{handle:(k:string,v:Function)=>mocks.handlers.set(k,v)},desktopCapturer:{getSources:mocks.sources},dialog:{showSaveDialog:mocks.save},
 clipboard:{writeImage:mocks.clipboard},nativeImage:{createFromBuffer:(bytes:Buffer)=>({isEmpty:()=>false,toPNG:()=>bytes})},screen:{on:(k:string,v:Function)=>mocks.displayEvents.set(k,v),
 dipToScreenRect:mocks.physicalBounds,getAllDisplays:()=>mocks.displays,getCursorScreenPoint:()=>({x:0,y:0}),getDisplayNearestPoint:()=>({id:10}),getDisplayMatching:()=>({id:10})}};
});
import {BrowserWindow} from 'electron';
import {installScreenshotIpc} from '../src/desktop-screenshot-ipc.js';
let owner:any, controller:ReturnType<typeof installScreenshotIpc>;
const event=(window:any,frame?:any)=>({sender:window.webContents,senderFrame:frame??window.webContents.mainFrame});
const call=(name:string,e:any,...args:any[])=>mocks.handlers.get('arkme-screenshot:'+name)!(e,...args);
const png=()=>{const b=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(100,16);b.writeUInt32BE(50,20);return b.toString('base64')};
beforeEach(()=>{vi.useFakeTimers();mocks.handlers.clear();mocks.clipboard.mockReset();mocks.windows.length=0;mocks.scope='a';mocks.blocked=false;mocks.allowed=true;mocks.construct.mockReset();mocks.load.mockReset();mocks.nativeWindows=[];mocks.physicalBounds.mockImplementation((_window:any,bounds:any)=>bounds);mocks.write.mockReset();mocks.save.mockReset();mocks.sources.mockReset();
 mocks.displays=[{id:10,bounds:{x:-800,y:0,width:800,height:600},size:{width:800,height:600},scaleFactor:2}];
 owner=new BrowserWindow();mocks.sources.mockResolvedValue([{display_id:'10',thumbnail:{isEmpty:()=>false,getSize:()=>({width:1600,height:1200}),toPNG:()=>Buffer.from('frame')}}]);
 controller=installScreenshotIpc({blocked:()=>mocks.blocked,main:()=>owner,origin:()=> 'http://localhost:1234',scope:()=>mocks.scope,preload:()=>'/preload',allowed:id=>mocks.allowed && id===owner.webContents.id});
});
afterEach(()=>{for(const w of mocks.windows)if(!w.destroyed)w.destroy();vi.useRealTimers();vi.unstubAllGlobals()});
async function start(){const result=call('capture',event(owner),'request');await vi.advanceTimersByTimeAsync(200);return {result,child:mocks.windows[1]}}
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
