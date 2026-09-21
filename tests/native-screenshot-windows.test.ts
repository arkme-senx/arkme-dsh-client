import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({mac:vi.fn(),win:vi.fn()}));
vi.mock('../src/macos-screenshot-windows.js',()=>({readMacScreenshotWindows:mocks.mac}));
vi.mock('../src/windows-screenshot-windows.js',()=>({readWindowsScreenshotWindows:mocks.win}));
import {readScreenshotWindows} from '../src/native-screenshot-windows.js';
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
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
