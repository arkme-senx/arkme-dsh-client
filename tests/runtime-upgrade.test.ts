import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { RuntimeDataTransactionStore } from "../src/runtime-data-transaction.js";
import { DshAccountScopeStore } from "../src/dsh-account-scope.js";
import { commitRuntimeUpgrade, recoverRuntimeUpgrade, restoreFailedRuntimeTrial } from "../src/runtime-upgrade.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

async function fixture() {
  const userDataPath = await mkdtemp(path.join(tmpdir(), "arkme-upgrade-"));
  roots.push(userDataPath);
  const dshHome = path.join(userDataPath, "dsh");
  await mkdir(dshHome);
  await writeFile(path.join(dshHome, "session"), "before");
  const store = new RuntimeDataTransactionStore({userDataPath, environment: "test"});
  const transaction = (await store.begin({dshHome, releaseId: "target", harnessIdentity: "hash"}))!;
  return {userDataPath, dshHome, store, transaction};
}

test.each(["profile", "release"])("a crash committing %s rolls forward before candidate selection and keeps new data", async phase => {
  const {userDataPath, dshHome, transaction} = await fixture();
  const events: string[] = [];
  await writeFile(path.join(dshHome, "session"), "after");
  await expect(commitRuntimeUpgrade(transaction, {
    commitProfile: async () => { events.push("profile"); if (phase === "profile") throw new Error("crash"); },
    commitRelease: async () => { events.push("release"); throw new Error("crash"); }
  })).rejects.toThrow("crash");
  expect(transaction.record.phase).toBe("commit-decided");
  const store = new RuntimeDataTransactionStore({userDataPath, environment: "test"});
  events.length = 0;
  await recoverRuntimeUpgrade(store, {
    commitProfile: async (home, id) => { expect([home, id]).toEqual([dshHome, "target"]); events.push("profile"); },
    commitRelease: async id => { expect(id).toBe("target"); events.push("release"); }
  });
  expect(events).toEqual(["profile", "release"]);
  expect(await readFile(path.join(dshHome, "session"), "utf8")).toBe("after");
  expect(await store.recover()).toEqual([]);
  expect(await store.begin({dshHome, releaseId: "target", harnessIdentity: "hash"})).toBeUndefined();
});

test("a predecision crash restores data and never commits its unverified release", async () => {
  const {dshHome, store} = await fixture();
  await writeFile(path.join(dshHome, "session"), "trial");
  await recoverRuntimeUpgrade(store, {
    commitProfile: async () => { throw new Error("must not commit"); },
    commitRelease: async () => { throw new Error("must not commit"); }
  });
  expect(await readFile(path.join(dshHome, "session"), "utf8")).toBe("before");
});

test("missing committed artifacts keep the decision pending and do not restore the snapshot", async () => {
  const {dshHome, store, transaction} = await fixture();
  await transaction.markCommitDecided();
  await writeFile(path.join(dshHome, "session"), "new data");
  await expect(recoverRuntimeUpgrade(store, {
    commitProfile: async () => undefined,
    commitRelease: async () => { throw new Error("target missing"); }
  })).rejects.toThrow("target missing");
  expect(await readFile(path.join(dshHome, "session"), "utf8")).toBe("new data");
  expect((await store.recover())[0]?.kind).toBe("roll-forward-required");
});

test("failed child termination blocks Profile rollback and data restore until a later successful stop", async () => {
  const {dshHome, transaction} = await fixture();
  await writeFile(path.join(dshHome, "session"), "still written by child");
  let profileRestored = false;
  await expect(restoreFailedRuntimeTrial(transaction, {
    stopHarness: async () => { throw new Error("child still alive"); },
    rollbackProfile: async () => { profileRestored = true; }
  })).rejects.toThrow("child still alive");
  expect(profileRestored).toBe(false);
  expect(await readFile(path.join(dshHome, "session"), "utf8")).toBe("still written by child");
  expect(await restoreFailedRuntimeTrial(transaction, {
    stopHarness: async () => undefined,
    rollbackProfile: async () => { profileRestored = true; }
  })).toBe(true);
  expect(profileRestored).toBe(true);
  expect(await readFile(path.join(dshHome, "session"), "utf8")).toBe("before");
});

test("failure after commit decision stops the writer but does not restore either Profile or data", async () => {
  const {dshHome, transaction} = await fixture();
  await transaction.markCommitDecided();
  await writeFile(path.join(dshHome, "session"), "committed");
  let stopped = false;
  expect(await restoreFailedRuntimeTrial(transaction, {
    stopHarness: async () => { stopped = true; },
    rollbackProfile: async () => { throw new Error("must not restore"); }
  })).toBe(false);
  expect(stopped).toBe(true);
  expect(await readFile(path.join(dshHome, "session"), "utf8")).toBe("committed");
});

test("a committed legacy container restarted before relocation defers attestation moves until the writer stops", async () => {
  const {userDataPath, dshHome, transaction, store} = await fixture();
  const scopes = new DshAccountScopeStore(userDataPath, undefined,
    (source, target) => store.transferCommittedIdentity(source, target));
  const pending = await scopes.reconcile({kind: "guest"}, {deferLegacyMigration: true});
  expect(pending.status).toBe("relaunch");
  await transaction.markCommitDecided();
  await transaction.complete();

  // Simulate a restart in the narrow gap after commit and before directory move.
  expect((await scopes.launch({deferLegacyMigration: true})).owner.kind).toBe("legacy");
  expect(await store.begin({dshHome, releaseId: "target", harnessIdentity: "hash"})).toBeUndefined();
  await writeFile(path.join(dshHome, "session"), "writer resumed");
  expect((await scopes.reconcile({kind: "guest"}, {deferLegacyMigration: true})).status).toBe("relaunch");
  expect(await readFile(path.join(dshHome, "session"), "utf8")).toBe("writer resumed");

  // The caller has now stopped the writer; only this explicit launch may rename.
  const migrated = await scopes.launch();
  expect(await readFile(path.join(migrated.dshHome, "session"), "utf8")).toBe("writer resumed");
  await expect(store.begin({dshHome: migrated.dshHome, releaseId: "older", harnessIdentity: "old"}))
    .rejects.toThrow("explicit harness transition");
});
