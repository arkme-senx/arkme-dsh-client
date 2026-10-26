import { beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Function>(), children: [] as any[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    webContents: any;
    constructor() {
      super(); const frame = { url: 'http://127.0.0.1:1111/?arkmeLongArticle=1' };
      this.webContents = Object.assign(new EventEmitter(), { id: mocks.children.length + 10, mainFrame: frame,
        send: vi.fn(), setWindowOpenHandler: vi.fn() });
      mocks.children.push(this);
    }
    loadURL = vi.fn(async () => {}); show = vi.fn(); focus = vi.fn(); restore = vi.fn(); isMinimized = () => false;
    close = vi.fn(); isDestroyed = () => false;
    static getAllWindows() { return mocks.children; }
  }
  return { BrowserWindow: Window, ipcMain: { handle: (name: string, handler: Function) => mocks.handlers.set(name, handler) }, shell: { openExternal: vi.fn() } };
});
import { installLongArticleWindowIpc } from '../src/long-article-window-ipc.js';
const target = { accountKey: 'prod:7', sourceKey: 'browse:location', sourceRef: 'browse:location', displayName: '位置', surface: 'location' };
function setup() {
  const frame = { url: 'http://127.0.0.1:1111/' };
  const main = { webContents: { id: 1, mainFrame: frame, getURL: () => frame.url, send: vi.fn(), session: {} },
    isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
  const changed = vi.fn();
  const manager = installLongArticleWindowIpc({ main: () => main as any, origin: () => 'http://127.0.0.1:1111', scope: () => 'runtime', preload: () => 'preload', changed });
  const invoke = (name: string, event: any, value?: unknown) => mocks.handlers.get('arkme-long-article:' + name)!(event, value);
  const mainEvent = { sender: main.webContents, senderFrame: frame };
  manager.setAccount(target.accountKey);
  return { main, manager, invoke, mainEvent, changed };
}
const eventFor = (window: any) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
beforeEach(() => { mocks.handlers.clear(); mocks.children.length = 0; });
it('only allows an active location top frame to navigate and focuses the main window', async () => {
  const { manager, main, invoke } = setup(); await manager.open(target);
  const event = eventFor(mocks.children[0]);
  const navigation = { source: { sourceRef: 'signed-chat' }, recordUid: 'record', sendAtMillis: 42 };
  expect(invoke('navigate', { ...event, senderFrame: { ...event.senderFrame } }, navigation)).toBe(false);
  expect(invoke('navigate', event, { recordUid: 'record' })).toBe(false);
  expect(invoke('navigate', event, navigation)).toBe(true);
  expect(main.webContents.send).toHaveBeenCalledWith('arkme-long-article:navigate', { ...navigation, accountKey: 'prod:7' });
  expect(main.restore).toHaveBeenCalledOnce(); expect(main.focus).toHaveBeenCalledOnce();
  manager.setAccount(null);
  expect(invoke('navigate', event, navigation)).toBe(false);
});
it('allows a library to open articles but denies stale and unrecognized renderers', async () => {
  const { manager, invoke, mainEvent } = setup(); await manager.open({ ...target, surface: 'library' });
  const library = eventFor(mocks.children[0]);
  const article = { ...target, surface: undefined, sourceRef: 'signed-self', sourceKey: 'self', article: { mode: 'existing', item: { itemUid: 'a' } } };
  await invoke('open', library, article); expect(mocks.children).toHaveLength(2);
  await expect(invoke('open', eventFor(mocks.children[1]), article)).rejects.toThrow('Untrusted');
  manager.setAccount(null); await expect(invoke('open', library, article)).rejects.toThrow('Untrusted');
  expect(invoke('account', library, 'prod:7')).toBe(false);
  expect(invoke('account', mainEvent, 'prod:7')).toBe(true);
});
it('broadcasts changes only from active editors or libraries and never accepts location writes', async () => {
  const { manager, invoke, changed, main } = setup();
  await manager.open(target); await manager.open({ ...target, surface: 'library' });
  expect(invoke('changed', eventFor(mocks.children[0]))).toBe(false);
  expect(invoke('changed', eventFor(mocks.children[1]))).toBe(true);
  expect(changed).toHaveBeenCalledOnce();
  expect(main.webContents.send).toHaveBeenCalledWith('arkme-long-article:changed');
  expect(mocks.children[1].webContents.send).toHaveBeenCalledWith('arkme-long-article:changed');
  manager.setAccount(null); expect(invoke('changed', eventFor(mocks.children[1]))).toBe(false);
});
