import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DesktopSessionSelection } from "../src/session-selection.js";
import type { DshAccountScopeLaunch } from "../src/dsh-account-scope.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function scope(name: string): Promise<DshAccountScopeLaunch> {
  const root = await mkdtemp(path.join(tmpdir(), `selection-${name}-`));
  directories.push(root);
  return { containerRef: name, dshHome: path.join(root, "dsh"), settingsPath: path.join(root, "settings.json"),
    logPath: path.join(root, "logs/harness.log"), runtimeScopeRef: `web:${name}`, owner: { kind: "account", accountRef: name } };
}
const sender = (port = 50001, id = 1) => ({ webContentsId: id, isMainFrame: true, url: `http://127.0.0.1:${port}/` });
const file = (s: DshAccountScopeLaunch) => path.join(path.dirname(s.settingsPath), "session-selection.json");

it("restores the last selection across processes and ports without mixing account containers", async () => {
  const a = await scope("a"), b = await scope("b");
  const store = new DesktopSessionSelection();
  await store.prepare(1, sender().url, a);
  const first = store.bootstrap(sender())!;
  expect(first.sessionId).toBeNull();
  expect(await store.save(sender(), { lease: first.lease, sessionId: "A" })).toBe(true);
  await store.prepare(1, sender(50002).url, b);
  const second = store.bootstrap(sender(50002))!;
  expect(second.sessionId).toBeNull();
  expect(await store.save(sender(50002), { lease: second.lease, sessionId: "B" })).toBe(true);
  const restarted = new DesktopSessionSelection();
  await restarted.prepare(1, sender(51000).url, a);
  expect(restarted.bootstrap(sender(51000))?.sessionId).toBe("A");
  expect(JSON.parse(await readFile(file(b), "utf8")).sessionId).toBe("B");
});

it("rejects old documents, other origins, subframes and late writes after logout", async () => {
  const a = await scope("a");
  const store = new DesktopSessionSelection();
  await store.prepare(1, sender().url, a);
  const old = store.bootstrap(sender())!;
  const fresh = store.bootstrap(sender())!;
  expect(await store.save(sender(), { lease: old.lease, sessionId: "old" })).toBe(false);
  expect(await store.save(sender(50002), { lease: fresh.lease, sessionId: "wrong-origin" })).toBe(false);
  expect(store.bootstrap({ ...sender(), isMainFrame: false })).toBeNull();
  expect(store.bootstrap(sender(50001, 2))).toBeNull();
  store.invalidate();
  expect(await store.save(sender(), { lease: fresh.lease, sessionId: "late" })).toBe(false);
  await expect(readFile(file(a))).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves the navigation address needed to restore catalog-only child sessions", async () => {
  const a = await scope("a");
  const store = new DesktopSessionSelection();
  await store.prepare(1, sender().url, a);
  const { lease } = store.bootstrap(sender())!;
  const subagentAddress = { parentSessionId: "parent", childSessionId: "child", mode: "continuable" };
  expect(await store.save(sender(), { lease, sessionId: "child", subagentAddress })).toBe(true);
  const restarted = new DesktopSessionSelection();
  await restarted.prepare(1, sender(51000).url, a);
  expect(restarted.bootstrap(sender(51000))).toMatchObject({ sessionId: "child", subagentAddress });
  expect(await store.save(sender(), { lease, sessionId: "other", subagentAddress })).toBe(false);
  expect(await store.save(sender(), { lease, sessionId: "child", subagentAddress: { ...subagentAddress, mode: "unknown" } })).toBe(false);
});

it("serializes rapid changes and drains accepted writes before preparing a reload", async () => {
  const a = await scope("a");
  const store = new DesktopSessionSelection();
  await store.prepare(1, sender().url, a);
  const { lease } = store.bootstrap(sender())!;
  const writes = ["A", "B", "C"].map(sessionId => store.save(sender(), { lease, sessionId }));
  await store.prepare(1, sender(50002).url, a);
  expect(await Promise.all(writes)).toEqual([true, true, true]);
  expect(store.bootstrap(sender(50002))?.sessionId).toBe("C");
  expect(await readdir(path.dirname(file(a)))).toEqual(["session-selection.json"]);
});

it("does not expose an account selection to guests or allow trial pages to overwrite it", async () => {
  const a = await scope("a");
  await writeFile(file(a), JSON.stringify({ version: 1, sessionId: "A", updatedAt: 1 }));
  const store = new DesktopSessionSelection();
  await store.prepare(2, sender().url, a, false);
  const trial = store.bootstrap(sender(50001, 2))!;
  expect(trial.sessionId).toBe("A");
  expect(await store.save(sender(50001, 2), { lease: trial.lease, sessionId: "trial" })).toBe(false);
  await store.prepare(1, sender().url, { ...a, owner: { kind: "guest" } });
  const guest = store.bootstrap(sender())!;
  expect(guest.sessionId).toBeNull();
  expect(await store.save(sender(), { lease: guest.lease, sessionId: "guest" })).toBe(false);
});

it("ignores corrupt records, rejects invalid selections, and preserves a record on I/O failure", async () => {
  const a = await scope("a");
  const store = new DesktopSessionSelection();
  await writeFile(file(a), "{broken");
  await store.prepare(1, sender().url, a);
  const state = store.bootstrap(sender())!;
  expect(state.sessionId).toBeNull();
  for (const sessionId of [null, "", "../escape", "x".repeat(257)]) {
    expect(await store.save(sender(), { lease: state.lease, sessionId })).toBe(false);
  }
  await rm(file(a));
  await mkdir(file(a));
  await expect(store.save(sender(), { lease: state.lease, sessionId: "A" })).rejects.toThrow();
  await rm(file(a), { recursive: true });
  expect(await store.save(sender(), { lease: state.lease, sessionId: "B" })).toBe(true);
  expect(JSON.parse(await readFile(file(a), "utf8")).sessionId).toBe("B");
});
