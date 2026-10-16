import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow } from 'electron';
import { DeviceLockSurfaces } from '../src/device-lock-surfaces.js';
import type { DesktopDeviceLockOwner, DeviceLockSnapshot } from '../src/device-lock-owner.js';

const mock = vi.hoisted(() => ({ windows: [] as any[], app: undefined as any }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  mock.app = new EventEmitter();
  class Contents extends EventEmitter {
    id = mock.windows.length + 1;
    setWindowOpenHandler = vi.fn(); closeDevTools = vi.fn(); send = vi.fn(); close = vi.fn();
    isDestroyed = () => false;
  }
  class Window extends EventEmitter {
    visible = false; focused = false; minimized = false; destroyed = false; contentProtected = false;
    title = 'private'; bounds = {x: 0, y: 0, width: 900, height: 700};
    webContents = new Contents();
    contentView = {addChildView: vi.fn(), removeChildView: vi.fn()};
    constructor(options: any = {}) { super(); this.visible = options.show !== false; mock.windows.push(this); mock.app.emit('browser-window-created', {}, this); }
    static getAllWindows() { return mock.windows.filter(w => !w.destroyed); }
    isVisible = () => this.visible; isFocused = () => this.focused; isMinimized = () => this.minimized;
    isDestroyed = () => this.destroyed; isContentProtected = () => this.contentProtected;
    getTitle = () => this.title; getBounds = () => this.bounds; getContentSize = () => [900, 700];
    setBounds = vi.fn(); setMenu = vi.fn(); closeFilePreview = vi.fn(); loadFile = vi.fn(async () => {});
    show = vi.fn(() => {this.visible = true; this.focus(); this.emit('show');});
    showInactive = vi.fn(() => {this.visible = true; this.emit('show');});
    focus = vi.fn(() => {for (const w of mock.windows) w.focused = false; this.focused = true; this.emit('focus');});
    hide = vi.fn(() => {this.visible = false; this.focused = false;});
    setTitle = vi.fn((title: string) => {this.title = title;});
    setContentProtection = vi.fn((value: boolean) => {this.contentProtected = value;});
    destroy = vi.fn(() => {this.destroyed = true; this.visible = false; this.emit('closed');});
  }
  class View { webContents = new Contents(); setBackgroundColor = vi.fn(); setBounds = vi.fn(); }
  return {app: mock.app, BrowserWindow: Window, WebContentsView: View, ipcMain: {handle: vi.fn()}};
});

function setup() {
  const window = new BrowserWindow({show: true}) as any;
  const original = {show: window.show, showInactive: window.showInactive, focus: window.focus, hide: window.hide};
  let locked = false;
  const snapshot = (): DeviceLockSnapshot => ({supported: true, locked, sessionEnded: false, needsCredentials: false, platform: 'macos', message: ''});
  const owner = {get protected() {return locked;}, snapshot} as DesktopDeviceLockOwner;
  const surfaces = new DeviceLockSurfaces(owner, 'preload', 'lock.html');
  return {window, original, surfaces, update: (value: boolean) => {locked = value; surfaces.update(snapshot());}, guard: () => mock.windows.at(-1)};
}
beforeEach(() => {mock.app.removeAllListeners(); mock.windows.length = 0;});
describe('lock surface visibility', () => {
  it('never shows or focuses windows on ordinary unlocked snapshots', () => {
    const f = setup(); f.window.minimized = true;
    for (let i = 0; i < 1000; i++) f.update(false);
    expect(f.original.show).not.toHaveBeenCalled(); expect(f.original.showInactive).not.toHaveBeenCalled(); expect(f.original.focus).not.toHaveBeenCalled();
    expect(f.window.minimized).toBe(true);
  });
  it('replaces the focused window once, updates quietly and restores focus only for an active guard', () => {
    const f = setup(); f.window.focused = true; f.update(true);
    const guard = f.guard(); expect(f.window.isVisible()).toBe(false); expect(guard.isFocused()).toBe(true);
    guard.show.mockClear(); guard.focus.mockClear(); f.original.hide.mockClear();
    for (let i = 0; i < 1000; i++) f.update(true);
    expect(guard.show).not.toHaveBeenCalled(); expect(guard.focus).not.toHaveBeenCalled(); expect(f.original.hide).not.toHaveBeenCalled();
    f.update(false); expect(f.original.showInactive).toHaveBeenCalledOnce(); expect(f.original.focus).toHaveBeenCalledOnce();
    f.update(false); expect(f.original.showInactive).toHaveBeenCalledOnce(); expect(f.original.focus).toHaveBeenCalledOnce();
    expect(f.window.isContentProtected()).toBe(false);
  });
  it('does not activate on remote lock or unlock while another app has focus', () => {
    const f = setup(); f.update(true); const guard = f.guard();
    expect(guard.show).not.toHaveBeenCalled(); expect(guard.focus).not.toHaveBeenCalled(); expect(guard.showInactive).toHaveBeenCalledOnce();
    f.update(false); expect(f.original.focus).not.toHaveBeenCalled();
  });
  it('keeps a closed lock window closed across refreshes, allows explicit reopen and retains privacy', () => {
    const f = setup(); f.update(true); f.guard().destroy();
    for (let i = 0; i < 20; i++) f.update(true);
    expect(mock.windows).toHaveLength(2); expect(f.window.isVisible()).toBe(false); expect(f.window.isContentProtected()).toBe(true);
    f.surfaces.revealOnActivate(f.window); expect(mock.windows).toHaveLength(3); expect(mock.windows[2].isVisible()).toBe(true); expect(f.window.isVisible()).toBe(false);
  });
  it.each(['closed', 'hidden', 'minimized'])('does not resurrect windows on background unlock when guard is %s', state => {
    const f = setup(); f.update(true); const guard = f.guard();
    if (state === 'closed') guard.destroy();
    if (state === 'hidden') guard.hide();
    if (state === 'minimized') guard.minimized = true;
    f.update(false); f.update(false);
    expect(f.original.showInactive).not.toHaveBeenCalled(); expect(f.original.focus).not.toHaveBeenCalled(); expect(f.window.isVisible()).toBe(false);
    f.surfaces.revealOnActivate(f.window); expect(f.window.isVisible()).toBe(true);
  });
  it('does not route app activation back to main when another window or guard is visible', () => {
    const f = setup(); f.window.hide();
    const other = new BrowserWindow({show: true});
    f.surfaces.revealOnActivate(f.window); expect(f.window.isVisible()).toBe(false);
    other.hide(); f.window.show(); f.update(true);
    const guard = f.guard(); guard.show.mockClear(); guard.focus.mockClear();
    f.surfaces.revealOnActivate(f.window);
    expect(guard.show).not.toHaveBeenCalled(); expect(guard.focus).not.toHaveBeenCalled();
  });
});
