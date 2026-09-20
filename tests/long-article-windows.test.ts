import { describe, expect, it, vi } from "vitest";
import { LongArticleWindows } from "../src/long-article-windows.js";
const target = { accountKey: "prod:7", sourceKey: "chat:1", sourceRef: "signed-ref", displayName: "Product" };
function setup() {
  let scope = "runtime-1";
  const windows: any[] = [];
  const notify = vi.fn();
  const manager = new LongArticleWindows({
    scope: () => scope,
    create: () => {
      const handlers: Record<string, Function> = {};
      const window = { id: windows.length + 1, show: vi.fn(), focus: vi.fn(), restore: vi.fn(), isMinimized: () => false,
        on: (name: string, fn: Function) => { handlers[name] = fn }, send: vi.fn(),
        close: vi.fn(() => { const event = { preventDefault: vi.fn() }; handlers.close?.(event); if (!event.preventDefault.mock.calls.length) handlers.closed?.() }),
        load: vi.fn(async () => {}), handlers };
      windows.push(window); return window;
    }, notify,
  });
  manager.setAccount(target.accountKey);
  return { manager, windows, notify, changeScope: () => { scope = "runtime-2" } };
}
describe("long article windows", () => {
  it("deduplicates by account and source key while retaining original target", async () => {
    const { manager, windows } = setup();
    await manager.open(target); await manager.open({ ...target, sourceRef: "new-ref" });
    expect(windows).toHaveLength(1); expect(windows[0].focus).toHaveBeenCalled();
    expect(manager.context(1)?.sourceRef).toBe("signed-ref");
  });
  it("rejects malformed and stale account targets", async () => {
    const { manager, windows } = setup();
    await expect(manager.open({ ...target, accountKey: "prod:8" })).rejects.toThrow();
    await expect(manager.open({ ...target, sourceRef: "" })).rejects.toThrow();
    expect(windows).toHaveLength(0);
  });
  it("invalidates on account change, including switching back", async () => {
    const { manager, windows, notify } = setup(); await manager.open(target);
    manager.setAccount("prod:8"); manager.setAccount(target.accountKey);
    expect(manager.isActive(1)).toBe(false);
    expect(windows[0].send).toHaveBeenCalledWith("invalidated", undefined);
    expect(manager.created(1, { itemUid: "record" })).toBe(false); expect(notify).not.toHaveBeenCalled();
  });
  it("rejects operations after runtime scope changes", async () => {
    const { manager, changeScope } = setup(); await manager.open(target); changeScope();
    expect(manager.isActive(1)).toBe(false);
  });
  it("blocks native close until renderer handles draft", async () => {
    const { manager, windows } = setup(); await manager.open(target);
    manager.ready(1); windows[0].close(); expect(manager.size).toBe(1);
    expect(windows[0].send).toHaveBeenCalledWith("request-close", undefined);
    manager.finishClose(1); expect(manager.size).toBe(0);
  });
  it("does not continue quit when editor cancels", async () => {
    const { manager } = setup(); await manager.open(target); const quit = vi.fn();
    manager.ready(1); expect(manager.requestQuit(quit)).toBe(true); manager.cancelClose();
    manager.finishClose(1); expect(quit).not.toHaveBeenCalled();
  });
  it("resumes quit only after all editors close", async () => {
    const { manager } = setup(); await manager.open(target); await manager.open({ ...target, sourceKey: "chat:2" });
    manager.ready(1); manager.ready(2); const quit = vi.fn(); manager.requestQuit(quit); manager.finishClose(1); expect(quit).not.toHaveBeenCalled();
    manager.finishClose(2); expect(quit).toHaveBeenCalledOnce();
  });
  it("allows closing a failed boot that never registered an editor", async () => {
    const { manager, windows } = setup(); await manager.open(target);
    windows[0].close(); expect(manager.size).toBe(0);
  });
  it("routes receipt with immutable target and refuses unknown senders", async () => {
    const { manager, notify } = setup(); await manager.open(target);
    expect(manager.created(99, { itemUid: "x" })).toBe(false);
    expect(manager.created(1, { itemUid: "x" })).toBe(true);
    expect(notify).toHaveBeenCalledWith({ ...target, item: { itemUid: "x" } });
  });
});

it("keeps existing articles separate from creation and deduplicates the same article", async () => {
 const { manager, windows } = setup();
 await manager.open(target);
 await manager.open({ ...target, article: { mode: 'existing', item: { itemUid: 'a' } } });
 await manager.open({ ...target, article: { mode: 'existing', item: { itemUid: 'b' } } });
 await manager.open({ ...target, article: { mode: 'existing', item: { itemUid: 'a' } } });
 expect(windows).toHaveLength(3);
 expect(manager.created(2, { itemUid: 'wrong' })).toBe(false);
 expect(manager.created(2, { itemUid: 'a' })).toBe(true);
});
it("never accepts write receipts from snapshots", async () => {
 const { manager } = setup();
 await manager.open({ ...target, article: { mode: 'snapshot', item: { itemUid: 'a' } } });
 expect(manager.created(1, { itemUid: 'a' })).toBe(false);
});
