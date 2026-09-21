import {describe,it,expect,vi} from 'vitest';
import {ScreenshotShortcut, normalizeShortcut} from '../src/screenshot-shortcut.js';
describe('screenshot shortcut',()=>{
 it('validates combinations',()=>{expect(normalizeShortcut('Control+Shift+A')).toBe('Control+Shift+A');expect(normalizeShortcut('A')).toBe(null);expect(normalizeShortcut('Control+Control+A')).toBe(null)});
 it('keeps old binding and preference when replacement is occupied',()=>{const occupied=new Set(['Alt+B']);const register=vi.fn((key:string)=>!occupied.has(key));const save=vi.fn();const s=new ScreenshotShortcut('darwin',{register,unregister:vi.fn()},save,()=>{});expect(s.snapshot().accelerator).toBe('Command+Shift+A');expect(()=>s.set('Alt+B')).toThrow();expect(save).not.toHaveBeenCalled();expect(s.snapshot().accelerator).toBe('Command+Shift+A')});
 it('suspends recording and restores on cancel; saves only confirmed combo',()=>{const register=vi.fn(()=>true),unregister=vi.fn(),save=vi.fn();const s=new ScreenshotShortcut('win32',{register,unregister},save,()=>{});s.pause(true);expect(unregister).toHaveBeenCalledWith('Control+Shift+A');s.set('Control+Alt+B');expect(save).toHaveBeenCalledWith('Control+Alt+B');s.pause(false);expect(register).toHaveBeenLastCalledWith('Control+Alt+B',expect.any(Function))});
 it('rolls back when persistence fails',()=>{const s=new ScreenshotShortcut('win32',{register:()=>true,unregister:()=>{}},()=>{throw Error('disk')},()=>{});expect(()=>s.set('Control+B')).toThrow();expect(s.snapshot().accelerator).toBe('Control+Shift+A')});
});
