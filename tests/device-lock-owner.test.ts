import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopDeviceLockOwner } from "../src/device-lock-owner.js";
import type { PersistedDeviceLock } from "../src/device-lock-store.js";

const cycle = "initial_lock_cycle_000001";
const sessionId = "2_instance_session_000001";
const loginKey = "cd".repeat(32);
const token = `e30.${Buffer.from(JSON.stringify({ user_id: 1, client_id: 2 })).toString("base64url")}.signature`;
function fixture(authorization: "mobile" | "native" = "mobile") {
  let state: PersistedDeviceLock = { schemaVersion: 1, locked: true, ended: false, sequence: 1, cycle,
    binding: { userId: 1, clientId: 2, sessionId, cleanupToken: "ab".repeat(32), loginKey } };
  let serverLocked = true;
  let disconnected = false;
  let lostReceipt = false;
  let revoked = false;
  let accessExpired = false;
  let nativeResult: Promise<boolean> = Promise.resolve(true);
  let authentications = 0;
  const receipts: Array<Record<string, unknown>> = [];
  const operation = { id: "operation_request_0001", kind: "unlock", state: "awaiting_execution", session_id: sessionId,
    lock_cycle: cycle, authorization, expires_at: Date.now() + 100_000, dispatched_at: Date.now() };
  const network = (async (input, init) => {
    if (disconnected) throw new TypeError("Network unavailable");
    const route = new URL(String(input)).pathname.split("/").at(-1);
    if (route === "session-status") return new Response(JSON.stringify({ code: 200, data: { ended: revoked } }), {status: 200});
    if (accessExpired && route !== "cleanup") return new Response("", {status: 401});
    if (revoked && route !== "cleanup") return new Response("", { status: 403, headers: { "X-Jotmo-Device-Failure": "instance_ended" } });
    const device = { client_id: 2, session_id: sessionId, actual_lock: serverLocked ? "locked" : "unlocked", lock_cycle: cycle, report_sequence: 1, operation };
    if (route === "report") {
      const receipt = JSON.parse(String(init?.body)) as Record<string, unknown>; receipts.push(receipt);
      if (lostReceipt && receipt.actual_lock === "unlocked") return new Response("", { status: 503 });
      serverLocked = receipt.actual_lock === "locked";
    }
    return new Response(JSON.stringify({ code: 200, data: device }), { status: 200, headers: { "X-Jotmo-Server-Time": String(Date.now()) } });
  }) as typeof fetch;
  const options = { store: { read: () => structuredClone(state), write: (value: PersistedDeviceLock) => { state = structuredClone(value); } },
    baseURL: "https://jotmo.senguo.me", platform: "macos" as const, name: "Test Mac", available: async () => true,
    authenticate: async () => { authentications++; return await nativeResult; }, changed: () => undefined, fetch: network };
  return { owner: new DesktopDeviceLockOwner(options), options, state: () => state, operation, receipts,
    disconnect: () => { disconnected = true; }, reconnect: () => { disconnected = false; },
    loseReceipt: () => { lostReceipt = true; }, recover: () => { lostReceipt = false; }, revoke: () => { revoked = true; }, expireAccess: () => { accessExpired = true; },
    native: (result: Promise<boolean>) => { nativeResult = result; }, authentications: () => authentications };
}

afterEach(() => vi.useRealTimers());
describe("desktop lock authority", () => {
  it("can protect and use OS recovery before the first remote binding is available", async () => {
    const f = fixture();
    const network = vi.fn(f.options.fetch);
    const owner = new DesktopDeviceLockOwner({...f.options, fetch: network, store: {...f.options.store, read: () => undefined}});
    await owner.initialize(); await owner.lock();
    expect(owner.protected).toBe(true); expect(f.state().locked).toBe(true);
    expect(f.state().binding).toBeUndefined(); expect(network).not.toHaveBeenCalled();
    await owner.requestUnlock();
    expect(f.authentications()).toBe(1); expect(owner.protected).toBe(false);
    expect(network).not.toHaveBeenCalled(); owner.close();
  });
  it("locks and persists immediately while an old dispatch is blocked, then rejects its approval", async () => {
    const f = fixture();
    let release!: () => void;
    let blocked = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const owner = new DesktopDeviceLockOwner({...f.options, fetch: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/dispatch") && !blocked) { blocked = true; await gate; }
      return f.options.fetch(input, init);
    }});
    await owner.initialize(); await owner.bind(token, loginKey);
    const syncing = owner.synchronize();
    await vi.waitFor(() => expect(blocked).toBe(true));
    const locking = owner.lock();
    expect(f.state().cycle).not.toBe(cycle);
    expect(f.state().pendingReport?.actual_lock).toBe("locked");
    expect(await locking).toMatchObject({locked: true});
    expect(owner.snapshot().operationState).toBeUndefined();
    release(); await syncing; await owner.synchronize();
    expect(owner.protected).toBe(true);
    expect(owner.snapshot().operationState).toBeUndefined();
    expect(f.receipts.some(r => r.actual_lock === "unlocked")).toBe(false);
    expect(f.receipts.at(-1)?.lock_cycle).toBe(f.state().cycle);
    owner.close();
  });
  it("does not wait for a report and preserves a newer local lock through its old acknowledgement", async () => {
    const f = fixture();
    let release!: () => void;
    let block = false, reporting = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const owner = new DesktopDeviceLockOwner({...f.options, fetch: async (input, init) => {
      const response = await f.options.fetch(input, init);
      if (block && new URL(String(input)).pathname.endsWith("/report")) { block = false; reporting = true; await gate; }
      return response;
    }});
    await owner.initialize(); await owner.bind(token, loginKey);
    block = true; await owner.lock();
    await vi.waitFor(() => expect(reporting).toBe(true));
    for (let i = 0; i < 20; i++) await owner.lock();
    const latest = f.state().pendingReport;
    const before = f.receipts.length;
    release(); await owner.synchronize(); await owner.synchronize();
    expect(f.receipts.length - before).toBe(1);
    expect(f.receipts.at(-1)).toEqual(latest);
    expect(owner.protected).toBe(true);
    owner.close();
  });
  it("invalidates an unlock queued before the new local lock without opening an OS dialog", async () => {
    const f = fixture("native");
    let release!: () => void, blocked = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const owner = new DesktopDeviceLockOwner({...f.options, fetch: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/dispatch") && !blocked) { blocked = true; await gate; }
      return f.options.fetch(input, init);
    }});
    await owner.initialize(); await owner.bind(token, loginKey);
    const syncing = owner.synchronize(); await vi.waitFor(() => expect(blocked).toBe(true));
    const oldUnlock = owner.requestUnlock();
    await owner.lock(); release(); await syncing; await oldUnlock; await owner.synchronize();
    expect(f.authentications()).toBe(0); expect(owner.protected).toBe(true); owner.close();
  });
  it.each([
    [409, {reason: "mobile_capability_unknown"}], [409, {}], [503, {}],
  ])("falls back to OS authentication on command failure %s / %j", async (status, body) => {
    const f = fixture("native");
    const owner = new DesktopDeviceLockOwner({ ...f.options, fetch: async (input, init) => {
      const route = new URL(String(input)).pathname.split("/").at(-1);
      if (route === "command") return new Response(JSON.stringify(body), {status: Number(status)});
      const response = await f.options.fetch(input, init);
      if (route !== "dispatch") return response;
      const value = await response.json(); delete value.data.operation;
      return new Response(JSON.stringify(value), {status: 200, headers: response.headers});
    }});
    await owner.initialize(); await owner.bind(token, loginKey); await owner.requestUnlock();
    expect(owner.protected).toBe(false); expect(f.authentications()).toBe(1);
    expect(f.receipts.at(-1)).toMatchObject({actual_lock: "unlocked", unlock_source: "native"});
    expect(f.receipts.at(-1)).not.toHaveProperty("operation_id");
  });
  it("unlocks offline and preserves the native receipt through restart and reconnect", async () => {
    const f = fixture("native"); await f.owner.initialize(); await f.owner.bind(token, loginKey);
    f.disconnect(); await f.owner.lock(); const offlineCycle = f.state().cycle;
    await f.owner.requestUnlock();
    expect(f.owner.protected).toBe(false); expect(f.authentications()).toBe(1);
    expect(f.state().pendingReport).toMatchObject({actual_lock: "unlocked", unlock_source: "native", lock_cycle: offlineCycle});
    const restored = new DesktopDeviceLockOwner(f.options); await restored.initialize();
    expect(restored.protected).toBe(false);
    f.reconnect(); await restored.bind(token, loginKey);
    expect(restored.protected).toBe(false); expect(f.state().pendingReport).toBeUndefined();
  });
  it("does not discard OS success when connectivity fails during the dialog", async () => {
    const f = fixture("native");
    const owner = new DesktopDeviceLockOwner({...f.options, authenticate: async () => { f.disconnect(); return true; }});
    await owner.initialize(); await owner.bind(token, loginKey); await owner.requestUnlock();
    expect(owner.protected).toBe(false); expect(f.state().pendingReport?.unlock_source).toBe("native");
  });
  it("does not invent session revocation from an incomplete server response", async () => {
    const f = fixture("native");
    const owner = new DesktopDeviceLockOwner({...f.options, fetch: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/dispatch")) return new Response(JSON.stringify({code: 200, data: {}}));
      return f.options.fetch(input, init);
    }});
    await owner.initialize(); await owner.bind(token, loginKey); await owner.requestUnlock();
    expect(owner.snapshot()).toMatchObject({locked: false, sessionEnded: false}); expect(f.authentications()).toBe(1);
  });
  it("requires actual OS success offline and supports retry after cancellation", async () => {
    const f = fixture("native"); await f.owner.initialize(); await f.owner.bind(token, loginKey); f.disconnect();
    f.native(Promise.resolve(false)); await f.owner.requestUnlock();
    expect(f.owner.protected).toBe(true);
    expect(f.state().pendingReport?.actual_lock).not.toBe("unlocked");
    f.native(Promise.resolve(true)); await f.owner.requestUnlock(); expect(f.owner.protected).toBe(false);
  });
  it.each(["click", "timeout"])("offers native recovery when phone confirmation is stuck: %s", async mode => {
    vi.useFakeTimers();
    const f = fixture(); f.operation.state = "awaiting_confirmation";
    let commanded = false;
    const owner = new DesktopDeviceLockOwner({...f.options, fetch: async (input, init) => {
      const route = new URL(String(input)).pathname.split("/").at(-1);
      if (route === "command") commanded = true;
      const response = await f.options.fetch(input, init);
      const value = await response.json();
      if (route === "dispatch" && !commanded) delete value.data.operation;
      return new Response(JSON.stringify(value), {status: response.status, headers: response.headers});
    }});
    await owner.initialize(); await owner.bind(token, loginKey); await owner.requestUnlock();
    expect(owner.snapshot().operationState).toBe("awaiting_confirmation"); expect(f.authentications()).toBe(0);
    if (mode === "click") await owner.requestUnlock();
    else await vi.advanceTimersByTimeAsync(30_000);
    expect(f.authentications()).toBe(1); expect(owner.protected).toBe(false); owner.close();
  });
  it("recovers a corrupt local store only with successful OS authentication", async () => {
    const f = fixture("native");
    const owner = new DesktopDeviceLockOwner({...f.options, store: {read: () => {throw new Error("corrupt");}, write: f.options.store.write}});
    await owner.initialize(); await owner.requestUnlock();
    expect(owner.protected).toBe(false); expect(f.authentications()).toBe(1);
  });
  it("invalidates an earlier approval when explicitly locking an already locked app", async () => {
    const f = fixture(); await f.owner.initialize(); await f.owner.bind(token, loginKey);
    await f.owner.lock();
    expect(f.state().cycle).not.toBe(cycle);
    await f.owner.synchronize();
    expect(f.owner.protected).toBe(true);
    expect(f.receipts.some(receipt => receipt.actual_lock === "unlocked")).toBe(false);
  });
  it("rejects a logout from another login generation without revoking the current one", async () => {
    const f = fixture(); await f.owner.initialize(); await f.owner.bind(token, loginKey);
    await expect(f.owner.logout("different_login_session_0001")).rejects.toThrow();
    expect(f.owner.snapshot().sessionEnded).toBe(false);
    expect(f.state().binding?.sessionId).toBe(sessionId);
  });
  it("persists the applied fact and receipt atomically, then recovers a lost acknowledgement after restart", async () => {
    const f = fixture(); await f.owner.initialize(); await f.owner.bind(token, loginKey); f.loseReceipt();
    await f.owner.synchronize();
    expect(f.state().locked).toBe(false);
    expect(f.state().pendingReport).toMatchObject({ actual_lock: "unlocked", lock_cycle: cycle, operation_id: f.operation.id });
    f.recover();
    const restored = new DesktopDeviceLockOwner(f.options); await restored.initialize(); await restored.bind(token, loginKey);
    expect(restored.protected).toBe(false); expect(f.state().pendingReport).toBeUndefined();
    expect(f.authentications()).toBe(0);
  });
  it("keeps cancellation locked and reports only a definite not-applied result", async () => {
    const f = fixture("native"); f.native(Promise.resolve(false)); await f.owner.initialize(); await f.owner.bind(token, loginKey);
    await f.owner.requestUnlock(); expect(f.owner.protected).toBe(true);
    expect(f.receipts.at(-1)).toMatchObject({ actual_lock: "locked", not_applied: true });
  });
  it("checks server revocation again after native success", async () => {
    const f = fixture("native"); let finish: (value: boolean) => void = () => undefined;
    f.native(new Promise(resolve => { finish = resolve; })); await f.owner.initialize(); await f.owner.bind(token, loginKey);
    const unlocking = f.owner.requestUnlock();
    while (f.authentications() === 0) await new Promise(resolve => setTimeout(resolve, 1));
    f.revoke(); finish(true); await unlocking;
    expect(f.owner.snapshot()).toMatchObject({ locked: true, sessionEnded: true });
    expect(f.receipts.some(receipt => receipt.actual_lock === "unlocked")).toBe(false);
  });
  it("invalidates a native success when another lock request arrives", async () => {
    const f = fixture("native"); let finish: (value: boolean) => void = () => undefined;
    f.native(new Promise(resolve => { finish = resolve; })); await f.owner.initialize(); await f.owner.bind(token, loginKey);
    const unlocking = f.owner.requestUnlock();
    while (f.authentications() === 0) await new Promise(resolve => setTimeout(resolve, 1));
    const locking = f.owner.lock(); finish(true); await unlocking; await locking;
    expect(f.owner.protected).toBe(true); expect(f.receipts.some(receipt => receipt.actual_lock === "unlocked")).toBe(false);
  });
  it("invalidates an open native proof before a replacement login can wait on the serial queue", async () => {
    const f = fixture("native"); let finish!: (value: boolean) => void;
    f.native(new Promise(resolve => { finish = resolve; })); await f.owner.initialize(); await f.owner.bind(token, loginKey);
    const unlocking = f.owner.requestUnlock();
    while (f.authentications() === 0) await new Promise(resolve => setTimeout(resolve, 1));
    const replacement = `e30.${Buffer.from(JSON.stringify({user_id: 1, client_id: 3, session_id: "replacement_session_0001"})).toString("base64url")}.signature`;
    const binding = f.owner.bind(replacement, "ef".repeat(32)); const rejected = expect(binding).rejects.toThrow("设备会话校验失败");
    finish(true); await unlocking; await rejected;
    expect(f.owner.protected).toBe(true); expect(f.receipts.some(r => r.actual_lock === "unlocked")).toBe(false);
  });
  it("does not prompt after a waiting phone request has been relocked", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.operation.state = "awaiting_confirmation"; let commanded = false;
    const owner = new DesktopDeviceLockOwner({...f.options, fetch: async (input, init) => {
      const route = new URL(String(input)).pathname.split("/").at(-1);
      if (route === "command") commanded = true;
      const response = await f.options.fetch(input, init); const value = await response.json();
      if (route === "dispatch" && !commanded) delete value.data.operation;
      return new Response(JSON.stringify(value), {status: response.status, headers: response.headers});
    }});
    await owner.initialize(); await owner.bind(token, loginKey); await owner.requestUnlock(); await owner.lock();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(owner.protected).toBe(true); expect(f.authentications()).toBe(0); owner.close();
  });
  it("never starts an unsolicited password prompt from background synchronization", async () => {
    const f = fixture("native"); await f.owner.initialize(); await f.owner.bind(token, loginKey); await f.owner.synchronize();
    expect(f.authentications()).toBe(0); expect(f.owner.protected).toBe(true);
  });
  it("does not claim local cleanup merely because revocation was observed", async () => {
    const f = fixture(); await f.owner.initialize(); await f.owner.bind(token, loginKey); f.revoke(); await f.owner.synchronize();
    expect(f.owner.protected).toBe(true); expect(f.state().binding).toBeDefined();
    await f.owner.completeLocalLogout(); expect(f.owner.protected).toBe(false); expect(f.state().binding).toBeUndefined();
    expect(f.state().pendingCleanup).toBeUndefined();
  });

  it("never newly applies a reconciling operation, even when the local wall clock is behind", async () => {
    const f = fixture(); const owner = new DesktopDeviceLockOwner({ ...f.options, now: () => 1 });
    await owner.initialize(); await owner.bind(token, loginKey); f.operation.state = "reconciling";
    await owner.synchronize(); expect(owner.protected).toBe(true);
    expect(f.receipts.at(-1)).toMatchObject({ not_applied: true, actual_lock: "locked" });
  });
  it("uses server time to reject expired requests despite local clock skew", async () => {
    const f = fixture(); const owner = new DesktopDeviceLockOwner({ ...f.options, now: () => 1 });
    await owner.initialize(); await owner.bind(token, loginKey); f.operation.expires_at = Date.now() - 1000;
    await owner.synchronize(); expect(owner.protected).toBe(true);
  });
  it("recovers revocation after access expiry without claiming local cleanup", async () => {
    const f = fixture(); await f.owner.initialize(); await f.owner.bind(token, loginKey); f.revoke(); f.expireAccess();
    await f.owner.synchronize(); expect(f.owner.snapshot()).toMatchObject({ sessionEnded: true, locked: true });
    expect(f.state().binding).toBeDefined();
  });
  it("requests credential refresh without treating an expired access token as logout", async () => {
    const f = fixture(); await f.owner.initialize(); await f.owner.bind(token, loginKey); f.expireAccess();
    await f.owner.synchronize(); expect(f.owner.snapshot()).toMatchObject({ sessionEnded: false, locked: true, needsCredentials: true });
  });
  it("starts protected when persisted lock evidence cannot be read", () => {
    const f = fixture(); const owner = new DesktopDeviceLockOwner({ ...f.options, store: { read: () => { throw new Error("corrupt"); }, write: () => undefined } });
    expect(owner.protected).toBe(true);
  });
});

describe("device instance registration without bearer session claims", () => {
  function registrationFixture() {
    let disk: PersistedDeviceLock | undefined;
    let current = "";
    let failAfterRegister = false;
    const calls: Array<{ route: string; body: Record<string, unknown>; instance: string }> = [];
    const options = { store: { read: () => disk, write: (value: PersistedDeviceLock) => { disk = structuredClone(value); } },
      baseURL: "https://jotmo.senguo.me", platform: "macos" as const, name: "Mac",
      available: async () => true, authenticate: async () => true, changed: () => undefined,
      fetch: (async (input, init) => {
        const route = new URL(String(input)).pathname.split("/").at(-1)!;
        const body = JSON.parse(String(init?.body));
        calls.push({route, body, instance: new Headers(init?.headers).get("X-Jotmo-Device-Instance") ?? ""});
        if (route === "registration") return Response.json({code: 200, data: {session_id: current}});
        if (route === "register") {
          if (current !== body.session_id && current !== body.previous_session_id) return new Response("", {status: 409});
          current = body.session_id;
          if (failAfterRegister) { failAfterRegister = false; throw new TypeError("lost response"); }
        }
        return Response.json({code: 200, data: {client_id: 2, session_id: current, report_sequence: 0}});
      }) as typeof fetch };
    return { options, calls, disk: () => disk, loseRegister: () => { failAfterRegister = true; }, replace: () => { current = "2_newer_instance_00001"; } };
  }
  it("registers the resolved computer name without converting Chinese or spaces", async () => {
    const f = registrationFixture();
    const owner = new DesktopDeviceLockOwner({ ...f.options, name: Promise.resolve("张三的 MacBook Pro") });
    await owner.initialize();
    await owner.bind(token, loginKey);
    expect(f.calls.find(call => call.route === "register")?.body.name).toBe("张三的 MacBook Pro");
    owner.close();
  });
  it("does not register after closing while the computer name is still loading", async () => {
    const f = registrationFixture();
    let resolveName!: (name: string) => void;
    let readingName = false;
    const name = new Promise<string>(resolve => { resolveName = resolve; });
    const owner = new DesktopDeviceLockOwner({ ...f.options, get name() { readingName = true; return name; } });
    await owner.initialize();
    const binding = owner.bind(token, loginKey);
    await vi.waitFor(() => expect(readingName).toBe(true));
    owner.close();
    resolveName("张三的 MacBook Pro");
    await expect(binding).rejects.toThrow("登录状态已变化");
    expect(f.calls.filter(call => call.route === "register")).toHaveLength(0);
  });
  it("clears local protection and pending registration when logout precedes registration success", async () => {
    const f = registrationFixture(); f.loseRegister();
    const owner = new DesktopDeviceLockOwner(f.options);
    await owner.initialize(); await owner.lock();
    await expect(owner.bind(token, loginKey)).rejects.toThrow();
    expect(f.disk()!.pendingRegistration).toBeDefined();
    await expect(owner.logout(undefined, "ef".repeat(32))).rejects.toThrow();
    await owner.logout(undefined, loginKey); await owner.completeLocalLogout();
    expect(owner.protected).toBe(false); expect(f.disk()!.pendingRegistration).toBeUndefined();
    expect(f.disk()!.binding).toBeUndefined(); owner.close();
  });
  it("fences registration in flight when local logout starts", async () => {
    const f = registrationFixture(); let release!: () => void, blocked = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const owner = new DesktopDeviceLockOwner({...f.options, fetch: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/registration")) { blocked = true; await gate; }
      return f.options.fetch(input, init);
    }});
    await owner.initialize(); await owner.lock();
    const binding = owner.bind(token, loginKey); const rejected = expect(binding).rejects.toThrow("登录状态已变化");
    await vi.waitFor(() => expect(blocked).toBe(true));
    await owner.logout(undefined, loginKey); release(); await rejected; await owner.completeLocalLogout();
    expect(owner.protected).toBe(false); expect(f.calls.some(c => c.route === "register")).toBe(false);
    expect(f.disk()!.pendingRegistration).toBeUndefined(); owner.close();
  });
  it("retains a new instance and its CAS predecessor after a lost registration response and restart", async () => {
    const f = registrationFixture(); f.loseRegister();
    const owner = new DesktopDeviceLockOwner(f.options);
    await expect(owner.bind(token, loginKey)).rejects.toThrow();
    const pending = f.disk()!.pendingRegistration!;
    expect(pending.sessionId).toMatch(/^2_/); expect(pending.previousSessionId).toBe("");
    owner.close();
    const restored = new DesktopDeviceLockOwner(f.options);
    await restored.bind(token, loginKey);
    expect(restored.snapshot().sessionId).toBe(pending.sessionId);
    expect(f.calls.filter(c => c.route === "registration")).toHaveLength(1);
    expect(f.calls.filter(c => c.route === "report").every(c => c.instance === pending.sessionId)).toBe(true);
    restored.close();
  });
  it("does not rebase an old retry over a newer instance", async () => {
    const f = registrationFixture(); f.loseRegister();
    const owner = new DesktopDeviceLockOwner(f.options);
    await expect(owner.bind(token, loginKey)).rejects.toThrow(); f.replace();
    await expect(owner.bind(token, loginKey)).rejects.toThrow();
    expect(f.calls.filter(c => c.route === "registration")).toHaveLength(1);
    owner.close();
  });
  it("refreshes bearer credentials without replacing the instance but isolates a fresh login", async () => {
    const f = registrationFixture(); const owner = new DesktopDeviceLockOwner(f.options);
    await owner.bind(token, loginKey); const first = owner.snapshot().sessionId;
    await owner.bind(token + "refreshed", loginKey); expect(owner.snapshot().sessionId).toBe(first);
    await owner.bind(token, "ef".repeat(32)); expect(owner.snapshot().sessionId).not.toBe(first);
    expect(f.calls.filter(c => c.route === "register").at(-1)!.body.previous_session_id).toBe(first);
    owner.close();
  });
  it("marks local logout immediately while offline and keeps its cleanup receipt across restart", async () => {
    const f = fixture(); await f.owner.initialize(); await f.owner.bind(token, loginKey); f.disconnect();
    expect((await f.owner.logout(sessionId)).sessionEnded).toBe(true);
    await f.owner.completeLocalLogout();
    expect(f.state().binding).toBeUndefined(); expect(f.state().pendingCleanup?.sessionId).toBe(sessionId);
    f.owner.close(); f.reconnect(); const restored = new DesktopDeviceLockOwner(f.options);
    await restored.synchronize(); expect(f.state().pendingCleanup).toBeUndefined(); restored.close();
  });
});
