import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({mac:vi.fn(),macAsync:vi.fn(),win:vi.fn()}));
vi.mock('../src/macos-screenshot-windows.js',()=>({readMacScreenshotWindows:mocks.mac,readMacScreenshotWindowsAsync:mocks.macAsync}));
vi.mock('../src/windows-screenshot-windows.js',()=>({readWindowsScreenshotWindows:mocks.win}));
import {readScreenshotWindows,createScreenshotWindowReader} from '../src/native-screenshot-windows.js';
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();vi.useRealTimers();});
it.each(['darwin','win32'])('routes %s to its native reader and degrades to manual selection on failure',platform=>{
 vi.stubGlobal('process',{...process,platform});
 const reader=platform==='darwin'?mocks.mac:mocks.win;
 const rectangles=[{x:0,y:0,width:100,height:200}];reader.mockReturnValueOnce(rectangles);
 expect(readScreenshotWindows()).toEqual(rectangles);
 reader.mockImplementationOnce(()=>{throw new Error('native unavailable');});expect(readScreenshotWindows()).toEqual([]);
});
it('does not load either platform reader on unsupported platforms',()=>{
 vi.stubGlobal('process',{...process,platform:'linux'});expect(readScreenshotWindows()).toEqual([]);
 expect(mocks.mac).not.toHaveBeenCalled();expect(mocks.win).not.toHaveBeenCalled();
});

it('bounds a stalled native read without queuing work or reusing late window coordinates',async()=>{
 vi.useFakeTimers();
 let release!:(value:any[])=>void;
 const native=vi.fn().mockImplementationOnce(()=>new Promise<any[]>(resolve=>{release=resolve})).mockResolvedValue([{x:1,y:2,width:3,height:4}]);
 const read=createScreenshotWindowReader(native,100);
 const first=read();
 await vi.advanceTimersByTimeAsync(100);
 await expect(first).resolves.toEqual([]);
 await expect(read()).resolves.toEqual([]);
 expect(native).toHaveBeenCalledTimes(1);
 release([{x:99,y:99,width:10,height:10}]);await vi.advanceTimersByTimeAsync(0);
 await expect(read()).resolves.toEqual([{x:1,y:2,width:3,height:4}]);
 expect(vi.getTimerCount()).toBe(0);
 vi.useRealTimers();
});
it('keeps manual selection available after native errors and recovers on the next request',async()=>{
 const native=vi.fn().mockRejectedValueOnce(new Error('native failed')).mockResolvedValue([{x:5,y:6,width:7,height:8}]);
 const read=createScreenshotWindowReader(native,100);
 await expect(read()).resolves.toEqual([]);
 await expect(read()).resolves.toEqual([{x:5,y:6,width:7,height:8}]);
});

it('uses the asynchronous macOS native reader in the bounded capture path',async()=>{
 vi.stubGlobal('process',{...process,platform:'darwin'});
 mocks.mac.mockImplementation(()=>{throw new Error('synchronous enumeration must not run')});
 mocks.macAsync.mockResolvedValue([{x:1,y:2,width:300,height:200}]);
 await expect(createScreenshotWindowReader()()).resolves.toEqual([{x:1,y:2,width:300,height:200}]);
 expect(mocks.mac).not.toHaveBeenCalled();
});
