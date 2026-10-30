import { afterEach, expect, test, vi } from "vitest";
import { startDesktopCapabilityBridge, type DesktopCapabilityBridge } from "../src/desktop-capability-bridge.js";
import { DesktopDeviceLockOwner } from "../src/device-lock-owner.js";
import type { PersistedDeviceLock } from "../src/device-lock-store.js";

const loginKey = "ab".repeat(32);
const sessionId = "2_instance_session_000001";
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(disposers.splice(0).map(dispose => dispose())); });

async function fixture(registered = false) {
  let state: PersistedDeviceLock = { schemaVersion: 1, locked: false, ended: false, cycle: "cycle_000001", sequence: 0,
    ...(registered ? { binding: { userId: 1, clientId: 2, sessionId, loginKey, cleanupToken: "cd".repeat(32) } } : {}) };
  const network = vi.fn<typeof fetch>();
  const owner = new DesktopDeviceLockOwner({
    store: { read: () => state, write: next => { state = next; } },
    baseURL: "https://jotmo.senguo.me", platform: "windows", name: "Test Windows",
    available: async () => false, authenticate: async () => false, changed: () => undefined, fetch: network
  });
  const bridge = await startDesktopCapabilityBridge({
    deviceLock: owner, notifications: { submit: vi.fn() }, notificationSupported: () => false,
    badges: { mode: "count", beginSession: vi.fn(), endSession: vi.fn(), applySnapshot: vi.fn() }
  });
  bridge.activateSession("bridge-session");
  disposers.push(async () => { owner.close(); await bridge.close(); });
  return { bridge, owner, network, state: () => state };
}

async function logout(bridge: DesktopCapabilityBridge, payload: unknown) {
  return fetch(bridge.url, { method: "POST", headers: {
    authorization: `Bearer ${bridge.token}`, "content-type": "application/json"
  }, body: JSON.stringify({ schemaVersion: 1, sessionId: "bridge-session", action: "device.lock.logout", payload }) });
}

test("logout succeeds with a login key before device registration and without remote I/O", async () => {
  const f = await fixture();
  const response = await logout(f.bridge, { loginKey });
  expect(response.status).toBe(200);
  expect((await response.json()).value.sessionEnded).toBe(true);
  expect(f.state().ended).toBe(true);
  expect(f.network).not.toHaveBeenCalled();
});

test.each([{ sessionId }, { loginKey }, { sessionId, loginKey }])("registered logout admits its supported identity fence: %j", async payload => {
  const f = await fixture(true);
  expect((await logout(f.bridge, payload)).status).toBe(200);
  expect(f.state().ended).toBe(true);
});

test.each([{}, { loginKey: "bad" }, { sessionId: "short" }, { loginKey: null }, { loginKey, extra: true }])("rejects missing, malformed, or expanded identity: %j", async payload => {
  const f = await fixture();
  expect((await logout(f.bridge, payload)).status).toBe(400);
  expect(f.state().ended).toBe(false);
});

test("a stale login key cannot end the current device session", async () => {
  const f = await fixture(true);
  expect((await logout(f.bridge, { loginKey: "ef".repeat(32) })).status).not.toBe(200);
  expect(f.state().ended).toBe(false);
});
