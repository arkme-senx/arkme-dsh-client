import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, fsyncSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileDeviceLockStore, type PersistedDeviceLock } from "../src/device-lock-store.js";
import { DesktopDeviceLockOwner } from "../src/device-lock-owner.js";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync), writeFileSync: vi.fn(fs.writeFileSync) };
});

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "arkme lock store "));
  directories.push(directory);
  return { directory, store: new FileDeviceLockStore(path.join(directory, "device-lock.json")) };
}
const initial: PersistedDeviceLock = {
  schemaVersion: 1, locked: false, ended: false, cycle: "initial_lock_cycle_000001", sequence: 0,
};
afterEach(() => {
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable device lock state", () => {
  it("creates, flushes, replaces and reloads the real file on the current OS", () => {
    const { directory, store } = fixture();
    expect(store.read()).toBeUndefined();
    store.write(initial);
    expect(store.read()).toEqual(initial);
    const locked = { ...initial, locked: true, sequence: 1 };
    store.write(locked);
    expect(store.read()).toEqual(locked);
    expect(readdirSync(directory)).toEqual(["device-lock.json"]);
  });

  it.each([
    ["write", writeFileSync], ["flush", fsyncSync], ["replace", renameSync],
  ] as const)("preserves the previous state and cleans temporary files after a %s failure", (_, fail) => {
    const { directory, store } = fixture();
    store.write(initial);
    const failure = new Error("injected storage failure");
    vi.mocked(fail).mockImplementationOnce(() => { throw failure; });
    expect(() => store.write({ ...initial, locked: true })).toThrow(failure);
    expect(store.read()).toEqual(initial);
    expect(readdirSync(directory)).toEqual(["device-lock.json"]);
    store.write({ ...initial, locked: true });
    expect(store.read()?.locked).toBe(true);
  });

  it("binds a device, persists an immediate offline lock and restores it after restart", async () => {
    const { store } = fixture();
    let offline = false;
    const options = {
      store, baseURL: "https://jotmo.senguo.me", platform: "windows" as const, name: "Windows test",
      available: async () => true, authenticate: async () => true, changed: () => undefined,
      fetch: (async () => {
        if (offline) throw new TypeError("offline");
        return new Response(JSON.stringify({ code: 200, data: {
          client_id: 2, session_id: "canonical_session_000001", actual_lock: "unlocked", report_sequence: 0,
        } }));
      }) as typeof fetch,
    };
    const owner = new DesktopDeviceLockOwner(options);
    try {
      await owner.initialize();
      await owner.bind(`e30.${Buffer.from(JSON.stringify({ user_id: 1, client_id: 2 })).toString("base64url")}.signature`);
      expect(store.read()?.binding?.sessionId).toBe("canonical_session_000001");
      expect(store.read()?.pendingReport).toBeUndefined();
      offline = true;
      const locked = owner.lock();
      expect(store.read()?.locked).toBe(true);
      expect((await locked).locked).toBe(true);
      await owner.synchronize();
      owner.close();
      const restored = new DesktopDeviceLockOwner(options);
      try { expect(restored.snapshot().locked).toBe(true); }
      finally { restored.close(); }
    } finally { owner.close(); }
  });
});
