import { EventEmitter } from 'node:events';
import type { BrowserWindow, OpenDialogReturnValue } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { NativeRecordingPicker } from '../src/recording-file-picker.js';

function fixture() {
  const events = new EventEmitter();
  const webContents = new EventEmitter();
  const owner = Object.assign(events, { id: 1, webContents, isDestroyed: () => false, isVisible: () => true,
    isFocused: () => true, isMinimized: () => false, isFullScreen: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1280, height: 820 }) }) as unknown as BrowserWindow;
  let resolve!: (result: OpenDialogReturnValue) => void;
  const show = vi.fn(() => new Promise<OpenDialogReturnValue>(done => { resolve = done; }));
  const diagnostic = vi.fn();
  return { owner, events, webContents, show, diagnostic, picker: new NativeRecordingPicker(show, diagnostic),
    resolve: (result: OpenDialogReturnValue) => resolve(result) };
}

describe('native recording chooser lifetime', () => {
  it('keeps the chooser pending through blur, hide and resize until native selection completes', async () => {
    const f = fixture();
    let settled = false;
    const result = f.picker.pick(f.owner, () => true).finally(() => { settled = true; });
    for (const event of ['blur', 'hide', 'resize', 'enter-full-screen']) f.events.emit(event);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.show).toHaveBeenCalledExactlyOnceWith(f.owner);
    f.resolve({ canceled: false, filePaths: ['/private/audio.wav'] });
    await expect(result).resolves.toMatchObject({ canceled: false });
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain('/private/audio.wav');
    expect(f.events.eventNames()).toEqual([]);
    expect(f.webContents.eventNames()).toEqual([]);
  });
  it('suppresses duplicate requests but allows selecting again after cancel and after a fresh process', async () => {
    const f = fixture();
    const first = f.picker.pick(f.owner, () => true);
    await expect(f.picker.pick(f.owner, () => true)).rejects.toThrow('已打开');
    f.resolve({ canceled: true, filePaths: [] });
    await expect(first).resolves.toMatchObject({ canceled: true });
    for (const picker of [f.picker, new NativeRecordingPicker(f.show, f.diagnostic)]) {
      const next = picker.pick(f.owner, () => true);
      f.resolve({ canceled: true, filePaths: [] });
      await expect(next).resolves.toMatchObject({ canceled: true });
    }
    expect(f.show).toHaveBeenCalledTimes(3);
  });
  it('rejects a selection after the account changes and releases its pending state', async () => {
    const f = fixture();
    let valid = true;
    const result = f.picker.pick(f.owner, () => valid);
    valid = false;
    f.resolve({ canceled: false, filePaths: ['/private/audio.wav'] });
    await expect(result).rejects.toThrow('账号已切换');
    const retry = f.picker.pick(f.owner, () => true);
    f.resolve({ canceled: true, filePaths: [] });
    await expect(retry).resolves.toMatchObject({ canceled: true });
  });
  it('releases the guard after a native failure, even when logging throws', async () => {
    const f = fixture();
    const show = vi.fn().mockRejectedValueOnce(new Error('native failed')).mockResolvedValue({ canceled: true, filePaths: [] });
    const picker = new NativeRecordingPicker(show, () => { throw new Error('logging failed'); });
    await expect(picker.pick(f.owner, () => true)).rejects.toThrow('native failed');
    await expect(picker.pick(f.owner, () => true)).resolves.toMatchObject({ canceled: true });
    expect(f.events.eventNames()).toEqual([]);
  });
});
