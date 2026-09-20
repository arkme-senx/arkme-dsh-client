import { describe, it, expect, vi } from 'vitest';
import { ConversationWindows } from '../src/conversation-windows.js';
const target = { accountKey: 'prod:7', sourceKey: 'chat:1', source: { kind: 'private_chat', sourceRef: 'ref', sourceKey: 'chat:1', displayName: '张三' } };
function setup() {
 let scope = 'one'; const windows: any[] = []; const notify = vi.fn();
 const manager = new ConversationWindows({ scope: () => scope, notify, create: () => {
  const handlers: Record<string, Function> = {};
  const win = { id: windows.length + 1, show: vi.fn(), focus: vi.fn(), restore: vi.fn(), isMinimized: () => true,
   send: vi.fn(), load: vi.fn(async () => {}), close: vi.fn(() => handlers.closed?.()), on: (event: string, fn: Function) => { handlers[event] = fn; } };
  windows.push(win); return win;
 }}); manager.setAccount('prod:7');
 return { manager, windows, notify, changeScope: () => { scope = 'two'; } };
}
describe('conversation windows', () => {
 it('deduplicates concurrent opens and keeps different conversations independent', async () => {
  const { manager, windows } = setup(); await Promise.all([manager.open(target), manager.open(target)]);
  expect(windows).toHaveLength(1); expect(windows[0].focus).toHaveBeenCalled();
  await manager.open({...target, sourceKey: 'chat:2', source: {...target.source, sourceKey: 'chat:2'}}); expect(windows).toHaveLength(2);
  expect(manager.context(1)).toEqual(target);
 });
 it('rejects AI, malformed and stale account targets', async () => {
  const { manager, windows } = setup();
  for (const value of [{...target, accountKey: 'prod:8'}, {...target, source: {...target.source, kind: 'arko'}}, {...target, sourceKey: ''}]) await expect(manager.open(value)).rejects.toThrow();
  expect(windows).toHaveLength(0);
 });
 it('invalidates account changes permanently and releases windows', async () => {
  const { manager, windows } = setup(); await manager.open(target); manager.setAccount(null); manager.setAccount('prod:7');
  expect(manager.isActive(1)).toBe(false); expect(windows[0].close).toHaveBeenCalled();
  await manager.open(target); expect(windows).toHaveLength(2);
 });
 it('rejects stale runtime and releases all children on main shutdown', async () => {
  const {manager, changeScope, windows} = setup(); await manager.open(target); changeScope(); expect(manager.isActive(1)).toBe(false);
  manager.closeAll(); expect(windows[0].close).toHaveBeenCalled(); expect(manager.size).toBe(0);
 });
 it('serializes submissions and releases locks when their owner closes', async () => {
  const {manager, windows} = setup(); await manager.open(target);
  expect(manager.acquire(1, 'draft')).toBe(true); expect(manager.acquire(0, 'draft')).toBe(false);
  manager.release(0, 'draft'); expect(manager.acquire(0, 'draft')).toBe(false);
  windows[0].close(); expect(manager.acquire(0, 'draft')).toBe(true);
 });
 it('relays scoped draft snapshots and clears them on account changes', async () => {
  const {manager, notify, windows} = setup(); await manager.open(target);
  manager.publish(0, {kind:'draft', key:'draft', value:{text:'hello'}});
  expect(manager.snapshot()).toEqual([{kind:'draft', key:'draft', value:{text:'hello'}}]);
  expect(windows[0].send).toHaveBeenCalledWith('event', {kind:'draft', key:'draft', value:{text:'hello'}, accountKey:'prod:7'});
  manager.publish(1, {kind:'changed'}); expect(notify).toHaveBeenCalledWith({kind:'changed',accountKey:'prod:7'});
  manager.setAccount(null); expect(manager.snapshot()).toEqual([]);
 });
});
it('does not echo draft edits to their originating renderer', async () => {
 const {manager, notify, windows} = setup(); await manager.open(target);
 manager.publish(0,{kind:'draft',key:'k',value:null}); expect(notify).not.toHaveBeenCalled();
 windows[0].send.mockClear(); manager.publish(1,{kind:'draft',key:'k',value:null}); expect(windows[0].send).not.toHaveBeenCalled();
});
it('keeps a sending window alive until its submission releases the lock', async () => {
 const {manager, windows} = setup(); await manager.open(target); manager.acquire(1,'draft'); manager.close(1);
 expect(windows[0].close).not.toHaveBeenCalled(); manager.release(1,'draft'); expect(windows[0].close).toHaveBeenCalled();
});
it('allows the next draft after consumption but protects both in-flight submissions from closing', async () => {
 const {manager,windows}=setup(); await manager.open(target);
 expect(manager.acquire(1,'draft','first')).toBe(true); manager.consumed(1,'draft','first');
 expect(manager.acquire(1,'draft','second')).toBe(true); manager.close(1);
 manager.release(1,'draft','first'); expect(windows[0].close).not.toHaveBeenCalled();
 manager.release(1,'draft','second'); expect(windows[0].close).toHaveBeenCalledOnce();
});

it('uses the same target validation for opening and main-window fallback', async () => {
 const {manager,changeScope} = setup();
 expect(manager.validateTarget(target)).toEqual(target);
 expect(()=>manager.validateTarget({...target,accountKey:'prod:8'})).toThrow();
 expect(()=>manager.validateTarget({...target,sourceKey:'other'})).toThrow();
 changeScope();
 expect(()=>manager.validateTarget(target)).toThrow();
 await expect(manager.open(target)).rejects.toThrow();
});
