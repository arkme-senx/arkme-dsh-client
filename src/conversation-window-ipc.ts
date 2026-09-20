import { BrowserWindow, ipcMain, shell } from 'electron';
import { ConversationWindows, type ConversationEvent } from './conversation-windows.js';
import { installAttachmentPreviewNative } from './attachment-preview-native.js';
const prefix = 'arkme-conversation:';
export function installConversationWindowIpc(options: {
 main(): BrowserWindow | null; origin(): string | null; scope(): string; preload(): string;
}) {
 const sameOrigin = (url: string) => { try { return new URL(url).origin === options.origin(); } catch { return false; } };
 const manager = new ConversationWindows({scope: options.scope,
  notify: event => { const main = options.main(); if (main && !main.isDestroyed()) main.webContents.send(prefix + 'event', event); },
  create: target => {
   const main = options.main(); if (!main || main.isDestroyed() || !sameOrigin(main.webContents.getURL())) throw new Error('Arkme 尚未就绪');
   const url = new URL(main.webContents.getURL()); url.search = '?arkmeConversation=1'; url.hash = '';
   const window = new BrowserWindow({width: 900, height: 780, minWidth: 640, minHeight: 520, show: false,
    title: target.source.displayName, backgroundColor: '#ffffff', autoHideMenuBar: true,
    webPreferences: {session: main.webContents.session, preload: options.preload(), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true}});
   const preview = installAttachmentPreviewNative(window, options.origin);
   window.webContents.on('will-navigate', (event, destination) => { if (destination !== url.href) event.preventDefault(); });
   window.webContents.on('will-redirect', event => event.preventDefault());
   window.webContents.on('will-attach-webview', event => event.preventDefault());
   window.webContents.setWindowOpenHandler(details => {
    const allowed = preview.handle(details); if (allowed) return allowed;
    try { if (['http:', 'https:'].includes(new URL(details.url).protocol)) void shell.openExternal(details.url); } catch {}
    return {action: 'deny'};
   });
   window.on('close', event => { if (manager.deferClose(window.webContents.id)) event.preventDefault(); });
   window.webContents.on('render-process-gone', () => window.destroy());
   return { id: window.webContents.id, show: () => window.show(), focus: () => window.focus(), restore: () => window.restore(),
    isMinimized: () => window.isMinimized(), close: () => window.close(), destroy: () => window.destroy(), load: () => window.loadURL(url.href),
    send: (event, value) => { if (!window.isDestroyed()) window.webContents.send(prefix + event, value); },
    on: (event, listener) => { window.on(event, listener); }};
  }});
 const sender = (event: Electron.IpcMainInvokeEvent): number | undefined => {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !sameOrigin(event.senderFrame.url)) return;
  if (event.sender.id === options.main()?.webContents.id) return 0;
  if (manager.isActive(event.sender.id)) return event.sender.id;
 };
 const keyValid = (key: unknown): key is string => typeof key === 'string' && key.length > 0 && key.length < 16384;
 ipcMain.handle(prefix + 'account', (event, account: unknown) => {
  if (sender(event) !== 0 || (account !== null && (typeof account !== 'string' || account.length > 256))) return false;
  manager.setAccount(account as string | null); return true;
 });
 ipcMain.handle(prefix + 'open', async (event, target: unknown) => { if (sender(event) === undefined) throw new Error('Untrusted conversation opener'); await manager.open(target); return true; });
 ipcMain.handle(prefix + 'context', event => sender(event) === undefined ? null : manager.context(event.sender.id) ?? null);
 ipcMain.handle(prefix + 'active', event => sender(event) !== undefined);
 ipcMain.handle(prefix + 'close', event => { if (sender(event)) manager.close(event.sender.id); });
 ipcMain.handle(prefix + 'snapshot', (event, account: unknown) => sender(event) === undefined || !manager.matchesAccount(account) ? [] : manager.snapshot());
 ipcMain.handle(prefix + 'publish', (event, value: unknown, account: unknown) => {
  if (!manager.matchesAccount(account)) return false;
  const id = sender(event); if (id === undefined || !value || typeof value !== 'object') return false;
  const message = value as ConversationEvent;
  if (message.kind !== 'changed' && ((message.kind !== 'draft' && message.kind !== 'article') || !keyValid(message.key) || JSON.stringify(message).length > 2000000)) return false;
  manager.publish(id, message); return true;
 });
 ipcMain.handle(prefix + 'acquire', (event, key: unknown, account: unknown, token: unknown) => { const id = sender(event); return manager.matchesAccount(account) && id !== undefined && keyValid(key) && keyValid(token) && manager.acquire(id, key, token); });
 ipcMain.handle(prefix + 'consumed', (event, key: unknown, account: unknown, token: unknown) => { const id = sender(event); if (manager.matchesAccount(account) && id !== undefined && keyValid(key) && keyValid(token)) manager.consumed(id, key, token); });
 ipcMain.handle(prefix + 'release', (event, key: unknown, account: unknown, token: unknown) => { const id = sender(event); if (manager.matchesAccount(account) && id !== undefined && keyValid(key) && keyValid(token)) manager.release(id, key, token); });
 ipcMain.handle(prefix + 'call', (event, mediaType: unknown) => {
  const id = sender(event); if (!id || (mediaType !== 'audio' && mediaType !== 'video')) return false;
  const context = manager.context(id); if (context?.source.kind !== 'private_chat') return false;
  manager.publish(id, {kind: 'call', source: context.source, mediaType});
  const main = options.main(); if (main?.isMinimized()) main.restore(); main?.show(); main?.focus(); return true;
 });
 ipcMain.handle(prefix + 'focus-main', (event, target: unknown) => {
  const id = sender(event); if (!id) return false;
  const context = manager.context(id); if (!context) return false;
  const destination = target === undefined ? context : manager.validateTarget(target);
  const main = options.main(); if (!main || main.isDestroyed()) return false;
  manager.publish(id, {kind: 'activate', source: destination.source});
  if (main.isMinimized()) main.restore(); main.show(); main.focus(); return true;
 });
 return manager;
}
