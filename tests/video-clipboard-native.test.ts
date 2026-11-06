import { describe, expect, it, vi } from 'vitest';
import { createNativeVideoClipboard, windowsFileDropBytes, windowsVideoClipboard, type WindowsVideoClipboardApi } from '../src/video-clipboard-native.js';
function fixture() {
  const api: WindowsVideoClipboardApi = { sequence: () => 7, open: vi.fn(() => true), close: vi.fn(), empty: vi.fn(() => true),
    allocate: vi.fn(() => 'movable-memory'), fill: vi.fn(), free: vi.fn(), setFiles: vi.fn(() => true), files: () => [] };
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(123n);
  return { api, handle, native: windowsVideoClipboard(api) };
}
describe('native video clipboard formats', () => {
  it('encodes a Unicode DROPFILES list, not text or a custom CF_HDROP name', () => {
    const bytes = windowsFileDropBytes('C:\\视频\\原片.mp4');
    expect(bytes.readUInt32LE(0)).toBe(20); expect(bytes.readUInt32LE(16)).toBe(1);
    expect(bytes.subarray(20).toString('utf16le')).toBe('C:\\视频\\原片.mp4\0\0');
  });
  it('opens with a trusted HWND and transfers memory ownership only after SetClipboardData', () => {
    const f = fixture(); f.native.write('C:\\video.mp4', 7, f.handle);
    expect(f.api.open).toHaveBeenCalledWith(123n); expect(f.api.empty).toHaveBeenCalledOnce();
    expect(f.api.setFiles).toHaveBeenCalledWith('movable-memory'); expect(f.api.free).not.toHaveBeenCalled(); expect(f.api.close).toHaveBeenCalledOnce();
  });
  it('checks sequence under the clipboard lock and frees memory without emptying on stale clicks', () => {
    const f = fixture(); expect(() => f.native.write('C:\\video.mp4', 6, f.handle)).toThrow('剪贴板');
    expect(f.api.empty).not.toHaveBeenCalled(); expect(f.api.free).toHaveBeenCalledWith('movable-memory'); expect(f.api.close).toHaveBeenCalledOnce();
  });
  it('fails explicitly and frees allocation when clipboard is busy or SetClipboardData fails', () => {
    const f = fixture(); vi.mocked(f.api.open).mockReturnValue(false);
    expect(() => f.native.write('C:\\video.mp4', 7, f.handle)).toThrow(); expect(f.api.free).toHaveBeenCalledOnce();
    const g = fixture(); vi.mocked(g.api.setFiles).mockReturnValue(false);
    expect(() => g.native.write('C:\\video.mp4', 7, g.handle)).toThrow(); expect(g.api.free).toHaveBeenCalledOnce(); expect(g.api.close).toHaveBeenCalledOnce();
  });
  it('rejects absent HWND and advertises unsupported platforms without fake success', () => {
    const f = fixture(); expect(() => f.native.write('C:\\video.mp4', 7)).toThrow(); expect(f.api.allocate).not.toHaveBeenCalled();
    const linux = createNativeVideoClipboard('linux'); expect(linux.supported).toBe(false); expect(() => linux.write('/tmp/video.mp4', 0)).toThrow();
  });
});
