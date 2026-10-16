import { describe, expect, it } from "vitest";
import { DesktopDeviceLockOwner } from "../src/device-lock-owner.js";
import type { PersistedDeviceLock } from "../src/device-lock-store.js";

const cycle = "initial_lock_cycle_000001";
const sessionId = "canonical_session_000001";
const token = `e30.${Buffer.from(JSON.stringify({ user_id: 1, client_id: 2 })).toString("base64url")}.signature`;
function fixture(authorization: "mobile" | "native" = "mobile") {
  let state: PersistedDeviceLock = { schemaVersion: 1, locked: true, ended: false, sequence: 1, cycle,
    binding: { userId: 1, clientId: 2, sessionId, cleanupToken: "ab".repeat(32) } };
  let serverLocked = true;
  let lostReceipt = false;
  let revoked = false;
  let accessExpired = false;
  let nativeResult: Promise<boolean> = Promise.resolve(true);
  let authentications = 0;
  const receipts: Array<Record<string, unknown>> = [];
  const operation = { id: "operation_request_0001", kind: "unlock", state: "awaiting_execution", session_id: sessionId,
    lock_cycle: cycle, authorization, expires_at: Date.now() + 100_000, dispatched_at: Date.now() };
  const network = (async (input, init) => {
    const route = new URL(String(input)).pathname.split("/").at(-1);
    if (route === "session-status") return new Response(JSON.stringify({ code: 200, data: { ended: revoked } }), {status: 200});
    if (accessExpired && route !== "cleanup") return new Response("", {status: 401});
    if (revoked && route !== "cleanup") return new Response("", { status: 403, headers: { "X-Jotmo-Auth-Failure": "session_ended" } });
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
    loseReceipt: () => { lostReceipt = true; }, recover: () => { lostReceipt = false; }, revoke: () => { revoked = true; }, expireAccess: () => { accessExpired = true; },
    native: (result: Promise<boolean>) => { nativeResult = result; }, authentications: () => authentications };
}

describe("desktop lock authority", () => {
  it.each([
    [409, {reason: "mobile_capability_unknown"}, "尚无法确认手机即我版本，请在手机登录即我后重试"],
    [409, {}, "设备状态已变化，请重试解锁"],
    [503, {}, "暂时无法获取设备状态，请重试"],
  ])("keeps protection and distinguishes command failure %s / %j", async (status, body, message) => {
    const f = fixture("native");
    const owner = new DesktopDeviceLockOwner({ ...f.options, fetch: async (input, init) => {
      const route = new URL(String(input)).pathname.split("/").at(-1);
      if (route === "command") return new Response(JSON.stringify(body), {status});
      const response = await f.options.fetch(input, init);
      if (route !== "dispatch") return response;
      const value = await response.json(); delete value.data.operation;
      return new Response(JSON.stringify(value), {status: 200, headers: response.headers});
    }});
    await owner.initialize(); await owner.bind(token);
    await expect(owner.requestUnlock()).rejects.toThrow(message);
    expect(owner.snapshot()).toMatchObject({locked: true, message});
    expect(f.authentications()).toBe(0);
    expect(f.receipts.some(receipt => receipt.actual_lock === "unlocked")).toBe(false);
  });
  it("invalidates an earlier approval when explicitly locking an already locked app", async () => {
    const f = fixture(); await f.owner.initialize(); await f.owner.bind(token);
    await f.owner.lock();
    expect(f.state().cycle).not.toBe(cycle);
    await f.owner.synchronize();
    expect(f.owner.protected).toBe(true);
    expect(f.receipts.some(receipt => receipt.actual_lock === "unlocked")).toBe(false);
  });
  it("rejects a logout from another login generation without revoking the current one", async () => {
    const f = fixture(); await f.owner.initialize(); await f.owner.bind(token);
    await expect(f.owner.logout("different_login_session_0001")).rejects.toThrow();
    expect(f.owner.snapshot().sessionEnded).toBe(false);
    expect(f.state().binding?.sessionId).toBe(sessionId);
  });
  it("persists the applied fact and receipt atomically, then recovers a lost acknowledgement after restart", async () => {
    const f = fixture(); await f.owner.initialize(); await f.owner.bind(token); f.loseReceipt();
    await f.owner.synchronize();
    expect(f.state().locked).toBe(false);
    expect(f.state().pendingReport).toMatchObject({ actual_lock: "unlocked", lock_cycle: cycle, operation_id: f.operation.id });
    f.recover();
    const restored = new DesktopDeviceLockOwner(f.options); await restored.initialize(); await restored.bind(token);
    expect(restored.protected).toBe(false); expect(f.state().pendingReport).toBeUndefined();
    expect(f.authentications()).toBe(0);
  });
  it("keeps cancellation locked and reports only a definite not-applied result", async () => {
    const f = fixture("native"); f.native(Promise.resolve(false)); await f.owner.initialize(); await f.owner.bind(token);
    await f.owner.requestUnlock(); expect(f.owner.protected).toBe(true);
    expect(f.receipts.at(-1)).toMatchObject({ actual_lock: "locked", not_applied: true });
  });
  it("checks server revocation again after native success", async () => {
    const f = fixture("native"); let finish: (value: boolean) => void = () => undefined;
    f.native(new Promise(resolve => { finish = resolve; })); await f.owner.initialize(); await f.owner.bind(token);
    const unlocking = f.owner.requestUnlock();
    while (f.authentications() === 0) await new Promise(resolve => setTimeout(resolve, 1));
    f.revoke(); finish(true); await expect(unlocking).rejects.toThrow("session-ended");
    expect(f.owner.snapshot()).toMatchObject({ locked: true, sessionEnded: true });
    expect(f.receipts.some(receipt => receipt.actual_lock === "unlocked")).toBe(false);
  });
  it("invalidates a native success when another lock request arrives", async () => {
    const f = fixture("native"); let finish: (value: boolean) => void = () => undefined;
    f.native(new Promise(resolve => { finish = resolve; })); await f.owner.initialize(); await f.owner.bind(token);
    const unlocking = f.owner.requestUnlock();
    while (f.authentications() === 0) await new Promise(resolve => setTimeout(resolve, 1));
    const locking = f.owner.lock(); finish(true); await unlocking; await locking;
    expect(f.owner.protected).toBe(true); expect(f.receipts.some(receipt => receipt.actual_lock === "unlocked")).toBe(false);
  });
  it("never starts an unsolicited password prompt from background synchronization", async () => {
    const f = fixture("native"); await f.owner.initialize(); await f.owner.bind(token); await f.owner.synchronize();
    expect(f.authentications()).toBe(0); expect(f.owner.protected).toBe(true);
  });
  it("does not claim local cleanup merely because revocation was observed", async () => {
    const f = fixture(); await f.owner.initialize(); await f.owner.bind(token); f.revoke(); await f.owner.synchronize();
    expect(f.owner.protected).toBe(true); expect(f.state().binding).toBeDefined();
    await f.owner.completeLocalLogout(); expect(f.owner.protected).toBe(false); expect(f.state().binding).toBeUndefined();
    expect(f.state().pendingCleanup).toBeUndefined();
  });

  it("never newly applies a reconciling operation, even when the local wall clock is behind", async () => {
    const f = fixture(); const owner = new DesktopDeviceLockOwner({ ...f.options, now: () => 1 });
    await owner.initialize(); await owner.bind(token); f.operation.state = "reconciling";
    await owner.synchronize(); expect(owner.protected).toBe(true);
    expect(f.receipts.at(-1)).toMatchObject({ not_applied: true, actual_lock: "locked" });
  });
  it("uses server time to reject expired requests despite local clock skew", async () => {
    const f = fixture(); const owner = new DesktopDeviceLockOwner({ ...f.options, now: () => 1 });
    await owner.initialize(); await owner.bind(token); f.operation.expires_at = Date.now() - 1000;
    await owner.synchronize(); expect(owner.protected).toBe(true);
  });
  it("recovers revocation after access expiry without claiming local cleanup", async () => {
    const f = fixture(); await f.owner.initialize(); await f.owner.bind(token); f.revoke(); f.expireAccess();
    await f.owner.synchronize(); expect(f.owner.snapshot()).toMatchObject({ sessionEnded: true, locked: true });
    expect(f.state().binding).toBeDefined();
  });
  it("requests credential refresh without treating an expired access token as logout", async () => {
    const f = fixture(); await f.owner.initialize(); await f.owner.bind(token); f.expireAccess();
    await f.owner.synchronize(); expect(f.owner.snapshot()).toMatchObject({ sessionEnded: false, locked: true, needsCredentials: true });
  });
  it("starts protected when persisted lock evidence cannot be read", () => {
    const f = fixture(); const owner = new DesktopDeviceLockOwner({ ...f.options, store: { read: () => { throw new Error("corrupt"); }, write: () => undefined } });
    expect(owner.protected).toBe(true);
  });
});
