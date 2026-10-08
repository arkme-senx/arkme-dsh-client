import { describe, expect, it, vi } from "vitest";
import { DesktopAccountScopeTransitions } from "../src/desktop-account-scope-transition.js";
import { startDesktopCapabilityBridge } from "../src/desktop-capability-bridge.js";

const guest = { kind: "guest" } as const;
function effects() { return { enter: vi.fn(async () => {}), restore: vi.fn(async () => {}) }; }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("account scope preparation recovery", () => {
  it("restores a failed navigation and permits the next prepare", async () => {
    const owner = new DesktopAccountScopeTransitions();
    const ui = effects();
    ui.enter.mockRejectedValueOnce(new Error("ERR_ABORTED"));
    await expect(owner.prepare(guest, ui)).rejects.toThrow("ERR_ABORTED");
    expect(ui.restore).toHaveBeenCalledOnce();
    expect(owner.active).toBe(false);
    const next = await owner.prepare(guest, ui);
    expect(owner.prepared(next.transitionRef).identity).toEqual(guest);
    owner.complete(next.transitionRef);
  });

  it("keeps preparation exclusive until timeout recovery has restored navigation", async () => {
    const owner = new DesktopAccountScopeTransitions();
    const loading = deferred();
    const restoring = deferred();
    const ui = { enter: vi.fn(() => loading.promise), restore: vi.fn(() => restoring.promise) };
    const abort = new AbortController();
    const pending = owner.prepare(guest, ui, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    await vi.waitFor(() => expect(ui.restore).toHaveBeenCalledOnce());
    await expect(owner.prepare(guest, effects())).rejects.toThrow("already active");
    restoring.resolve();
    await rejected;
    const next = await owner.prepare({ kind: "account", userId: 43 }, effects());
    loading.resolve();
    await Promise.resolve();
    expect(owner.prepared(next.transitionRef).identity).toEqual({ kind: "account", userId: 43 });
    owner.complete(next.transitionRef);
  });

  it("does not reveal an old account after the runtime resets during preparation", async () => {
    const owner = new DesktopAccountScopeTransitions();
    const loading = deferred();
    const ui = effects();
    ui.enter.mockImplementation(() => loading.promise);
    const pending = owner.prepare(guest, ui);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    owner.reset();
    const next = await owner.prepare({ kind: "account", userId: 43 }, effects());
    await rejected;
    loading.resolve();
    expect(ui.restore).not.toHaveBeenCalled();
    expect(owner.prepared(next.transitionRef).identity).toEqual({ kind: "account", userId: 43 });
    owner.complete(next.transitionRef);
  });

  it("invalidates a prepared lease without restoring an account whose credentials may have changed", async () => {
    const owner = new DesktopAccountScopeTransitions();
    const ui = effects();
    const abort = new AbortController();
    const prepared = await owner.prepare(guest, ui, abort.signal);
    abort.abort();
    expect(owner.active).toBe(false);
    expect(() => owner.prepared(prepared.transitionRef)).toThrow("stale");
    expect(ui.restore).not.toHaveBeenCalled();
  });

  it("releases a failed recovery and rejects stale or unfinished commits", async () => {
    const owner = new DesktopAccountScopeTransitions();
    const ui = effects();
    ui.enter.mockRejectedValueOnce(new Error("load failed"));
    ui.restore.mockRejectedValueOnce(new Error("restore failed"));
    await expect(owner.prepare(guest, ui)).rejects.toThrow("restore failed");
    expect(owner.active).toBe(false);
    expect(() => owner.complete("stale-transition")).toThrow("stale");
    const abort = new AbortController();
    abort.abort();
    await expect(owner.prepare(guest, ui, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(ui.enter).toHaveBeenCalledOnce();
  });

  it.each(["disconnect", "replace-session", "deactivate-session", "close"] as const)(
    "recovers an in-progress prepare when the real HTTP bridge sees %s", async mode => {
      const owner = new DesktopAccountScopeTransitions();
      const loading = deferred();
      const ui = effects();
      ui.enter.mockImplementationOnce(() => loading.promise);
      const bridge = await startDesktopCapabilityBridge({
        notifications: { submit: () => ({ accepted: false, outcome: "unsupported" }) },
        notificationSupported: () => false,
        badges: {
          mode: "unsupported",
          beginSession: () => ({ accepted: true, outcome: "accepted" }),
          endSession: () => ({ accepted: true, outcome: "accepted" }),
          applySnapshot: () => ({ accepted: false, outcome: "unsupported" })
        },
        accountScopes: {
          attest: async () => ({ status: "ready" }),
          prepare: async (identity, signal) => await owner.prepare(identity, ui, signal),
          commit: async ref => { owner.complete(ref); return { status: "ready" }; },
          abort: async ref => { owner.complete(ref); return { status: "ready" }; }
        }
      });
      bridge.activateSession("test-session-1");
      const abort = new AbortController();
      const send = (sessionId: string, signal?: AbortSignal) => fetch(bridge.url, {
        method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, sessionId, action: "account.scope.prepare", payload: guest }),
        ...(signal === undefined ? {} : { signal })
      });
      const request = send("test-session-1", abort.signal).catch(error => error as Error);
      try {
        await vi.waitFor(() => expect(ui.enter).toHaveBeenCalledOnce());
        if (mode === "disconnect") abort.abort();
        else if (mode === "replace-session") bridge.activateSession("test-session-2");
        else if (mode === "deactivate-session") bridge.deactivateSession("test-session-1");
        else await bridge.close();
        await vi.waitFor(() => expect(owner.active).toBe(false));
        expect(ui.restore).toHaveBeenCalledOnce();
        await request;
        if (mode !== "close") {
          bridge.activateSession("test-session-2");
          const response = await send("test-session-2");
          expect(response.status).toBe(200);
          const body = await response.json() as { value: { transitionRef: string } };
          loading.resolve();
          expect(owner.prepared(body.value.transitionRef).identity).toEqual(guest);
          owner.complete(body.value.transitionRef);
        }
      } finally {
        loading.resolve();
        await bridge.close();
      }
    }
  );
});
