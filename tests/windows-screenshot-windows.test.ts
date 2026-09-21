import {expect,it} from 'vitest';
import {readWindowsScreenshotWindows,type WindowsWindowApi} from '../src/windows-screenshot-windows.js';
const rect={x:10,y:20,width:640,height:480};
function api(overrides:Partial<WindowsWindowApi>={}):WindowsWindowApi {return {
 enumerate:()=>[1,2,3],above:h=>h===1?0:Number(h)-1,visible:()=>true,minimized:()=>false,cloaked:()=>false,
 transparent:()=>false,className:()=> 'Chrome_WidgetWin_1',bounds:()=>rect,...overrides,
};}
it('filters hidden, minimized, cloaked and shell windows',()=>{
 expect(readWindowsScreenshotWindows(api({visible:h=>h!==1,minimized:h=>h===2,cloaked:h=>h===3}))).toEqual([]);
 expect(readWindowsScreenshotWindows(api({className:h=>h===1?'Progman':h===2?'WorkerW':'Shell_TrayWnd'}))).toEqual([]);
});
it('orders windows by z-order even when enumeration is unordered',()=>{
 expect(readWindowsScreenshotWindows(api({enumerate:()=>[3,1,2],bounds:h=>({...rect,x:Number(h)*10})}))).toEqual([{...rect,x:10},{...rect,x:20},{...rect,x:30}]);
});
it('does not hang when a destroyed or moving window changes z-order',()=>{
 expect(readWindowsScreenshotWindows(api({above:h=>h}))).toHaveLength(3);
});
it('ignores invalid bounds and preserves visible app windows including Arkme',()=>{
 expect(readWindowsScreenshotWindows(api({bounds:h=>h===1?null:h===2?{...rect,width:0}:rect}))).toEqual([rect]);
});

it('ignores fully transparent layered windows without rejecting translucent windows',()=>{
 expect(readWindowsScreenshotWindows(api({transparent:h=>h!==2,bounds:h=>({...rect,x:Number(h)})}))).toEqual([{...rect,x:2}]);
});
