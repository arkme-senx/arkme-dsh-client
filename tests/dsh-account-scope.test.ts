import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  arkmePluginSupportsDesktopAccountScope,
  DshAccountScopeStore
} from "../src/dsh-account-scope.js";

const tempDirectories: string[] = [];

async function makeTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(async directory => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("DSH account scope store", () => {
  test("starts new installs in a guest-owned full DSH home", async () => {
    const userDataPath = await makeTempDirectory("arkme account scope ");
    const store = new DshAccountScopeStore(userDataPath, () => "scope_guest_01");

    const launch = await store.launch();

    expect(launch).toMatchObject({
      containerRef: "scope_guest_01",
      runtimeScopeRef: "web:scope_guest_01",
      owner: { kind: "guest" }
    });
    expect(launch.dshHome).toBe(join(userDataPath, "dsh-containers", "scope_guest_01", "dsh"));
    expect(launch.settingsPath).toBe(join(userDataPath, "dsh-containers", "scope_guest_01", "settings.json"));
    expect(launch.logPath).toBe(join(userDataPath, "dsh-containers", "scope_guest_01", "logs", "harness.log"));
  });

  test("claims an existing guest container for the authenticated account without moving it", async () => {
    const userDataPath = await makeTempDirectory("arkme-account-scope-");
    const refs = ["scope_guest_01"];
    const store = new DshAccountScopeStore(userDataPath, () => refs.shift()!);
    const guest = await store.launch();

    const result = await store.reconcile({ kind: "account", userId: 42 });
    const claimed = await store.launch();

    expect(result).toEqual({ status: "ready", launch: claimed });
    expect(claimed.dshHome).toBe(guest.dshHome);
    expect(claimed.owner).toEqual({ kind: "account", accountRef: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });

  test("moves the legacy DSH home only after relaunch and assigns it to the current account", async () => {
    const userDataPath = await makeTempDirectory("arkme account scope ");
    const legacyHome = join(userDataPath, "dsh");
    await mkdir(join(legacyHome, "sessions"), { recursive: true });
    await writeFile(join(legacyHome, "sessions", "conversation.jsonl"), "legacy\n");
    const store = new DshAccountScopeStore(userDataPath, () => "scope_legacy_01");

    const legacy = await store.launch();
    const transition = await store.reconcile({ kind: "account", userId: 7 });

    expect(legacy.dshHome).toBe(legacyHome);
    expect(transition.status).toBe("relaunch");
    const recovered = await new DshAccountScopeStore(userDataPath, () => "unused").launch();
    expect(recovered.dshHome).toBe(join(userDataPath, "dsh-containers", "scope_legacy_01", "dsh"));
    expect(await readFile(join(recovered.dshHome, "sessions", "conversation.jsonl"), "utf8")).toBe("legacy\n");
    expect(recovered.owner.kind).toBe("account");
  });

  test("logout switches to a fresh guest container and preserves the account home", async () => {
    const userDataPath = await makeTempDirectory("arkme-account-scope-");
    const refs = ["scope_a01", "scope_guest_after_logout"];
    const store = new DshAccountScopeStore(userDataPath, () => refs.shift()!);
    await store.launch();
    const account = (await store.reconcile({ kind: "account", userId: 42 })).launch;
    await writeFile(join(account.dshHome, "account-a.marker"), "A");

    const logout = await store.reconcile({ kind: "guest" });

    expect(logout.status).toBe("relaunch");
    expect(logout.launch.owner).toEqual({ kind: "guest" });
    expect(logout.launch.dshHome).not.toBe(account.dshHome);
    expect(await readFile(join(account.dshHome, "account-a.marker"), "utf8")).toBe("A");
  });

  test("account switches return to the account's prior preferred container", async () => {
    const userDataPath = await makeTempDirectory("arkme-account-scope-");
    const refs = ["scope_guest", "scope_guest_2"];
    const store = new DshAccountScopeStore(userDataPath, () => refs.shift()!);
    await store.launch();
    const accountA = (await store.reconcile({ kind: "account", userId: 42 })).launch;
    await store.reconcile({ kind: "guest" });
    const accountB = (await store.reconcile({ kind: "account", userId: 99 })).launch;

    const backToA = await store.reconcile({ kind: "account", userId: 42 });

    expect(accountB.dshHome).not.toBe(accountA.dshHome);
    expect(backToA.status).toBe("relaunch");
    expect(backToA.launch.dshHome).toBe(accountA.dshHome);
  });

  test("an empty guest login returns to the account's existing container", async () => {
    const userDataPath = await makeTempDirectory("arkme-account-scope-");
    const refs = ["scope_guest_01", "scope_guest_02"];
    const store = new DshAccountScopeStore(userDataPath, () => refs.shift()!);
    await store.launch();
    const account = (await store.reconcile({ kind: "account", userId: 42 })).launch;
    await store.reconcile({ kind: "guest" });

    const login = await store.reconcile({ kind: "account", userId: 42, claimCurrentGuest: false });

    expect(login.status).toBe("relaunch");
    expect(login.launch.dshHome).toBe(account.dshHome);
  });

  test("repeated logout reuses the previously empty guest container", async () => {
    const userDataPath = await makeTempDirectory("arkme-account-scope-");
    const refs = ["scope_guest_01", "scope_guest_02"];
    const store = new DshAccountScopeStore(userDataPath, () => refs.shift()!);
    await store.launch();
    await store.reconcile({ kind: "account", userId: 42 });
    const firstLogout = await store.reconcile({ kind: "guest" });
    await store.reconcile({ kind: "account", userId: 42, claimCurrentGuest: false });

    const secondLogout = await store.reconcile({ kind: "guest" });

    expect(secondLogout.launch.containerRef).toBe(firstLogout.launch.containerRef);
    expect(refs).toEqual([]);
  });

  test("lists and activates only containers owned by the current account", async () => {
    const userDataPath = await makeTempDirectory("arkme-account-scope-");
    const refs = ["scope_guest_01", "scope_guest_02"];
    const store = new DshAccountScopeStore(userDataPath, () => refs.shift()!);
    await store.launch();
    const first = (await store.reconcile({ kind: "account", userId: 42 })).launch;
    await store.reconcile({ kind: "guest" });
    const second = (await store.reconcile({ kind: "account", userId: 42, claimCurrentGuest: true })).launch;

    const choices = await store.accountContainers();
    const activated = await store.activate(first.containerRef);

    expect(choices).toHaveLength(2);
    expect(choices.find(choice => choice.containerRef === second.containerRef)?.active).toBe(true);
    expect(activated.dshHome).toBe(first.dshHome);
  });

  test("fails closed when the durable registry contains unknown fields", async () => {
    const userDataPath = await makeTempDirectory("arkme-account-scope-");
    const store = new DshAccountScopeStore(userDataPath, () => "scope_guest_01");
    await store.launch();
    const registryPath = join(userDataPath, "dsh-account-scopes.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as Record<string, unknown>;
    await writeFile(registryPath, JSON.stringify({ ...registry, accountToken: "must-not-be-accepted" }));

    await expect(new DshAccountScopeStore(userDataPath).launch()).rejects.toThrow(/registry is invalid/i);
  });

  test("detects the packaged plugin contract without using its version string", async () => {
    const pluginPath = await makeTempDirectory("arkme-plugin-contract-");
    await writeFile(join(pluginPath, "package.json"), JSON.stringify({
      version: "0.1.35",
      arkme: { desktopAccountScope: { version: 1 } }
    }));
    expect(await arkmePluginSupportsDesktopAccountScope(pluginPath)).toBe(true);
    await writeFile(join(pluginPath, "package.json"), JSON.stringify({ version: "0.1.35" }));
    expect(await arkmePluginSupportsDesktopAccountScope(pluginPath)).toBe(false);
  });

  test("switches the visible Harness log together with the account container", async () => {
    const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function switchAccountScopeRuntime");
    const end = source.indexOf("function accountScopeLaunchPaths", start);
    const switchBlock = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(switchBlock).toContain("logPath = scope.logPath");
    expect(switchBlock.indexOf("logPath = scope.logPath"))
      .toBeLessThan(switchBlock.indexOf("launchHarnessRuntime("));
  });
});

test('repeated trial attestation retains pending legacy data and rejects identity changes until relaunch', async () => {
  const userData = await makeTempDirectory('account-scope-deferred-');
  const store = new DshAccountScopeStore(userData, () => 'scope_deferred_01');
  const initial = await store.legacyLaunch();
  await writeFile(join(initial.dshHome, 'records'), 'trial');
  const first = await store.reconcile({kind:'guest'}, {deferLegacyMigration:true});
  const registry = await readFile(join(userData,'dsh-account-scopes.json'),'utf8');
  const second = await store.reconcile({kind:'guest'}, {deferLegacyMigration:true});
  expect(second).toEqual(first);
  expect(second.status).toBe('relaunch');
  expect(await readFile(join(initial.dshHome,'records'),'utf8')).toBe('trial');
  expect(await readFile(join(userData,'dsh-account-scopes.json'),'utf8')).toBe(registry);
  await expect(store.reconcile({kind:'account',userId:42},{deferLegacyMigration:true})).rejects.toThrow('identity');
  expect(await readFile(join(initial.dshHome,'records'),'utf8')).toBe('trial');
  const launched = await store.launch();
  expect(await readFile(join(launched.dshHome,'records'),'utf8')).toBe('trial');
});

test('migration identity callback must finish before rename and is retried after failure', async () => {
  const userData = await makeTempDirectory('account-scope-before-move-');
  let allowed = false;
  let calls = 0;
  const store = new DshAccountScopeStore(userData, ()=>'scope_protected_01', async (source,target) => {
    calls++;
    expect(source).toBe(join(userData,'dsh'));
    expect(target).toBe(join(userData,'dsh-containers','scope_protected_01','dsh'));
    expect(await readFile(join(source,'records'),'utf8')).toBe('committed');
    if (!allowed) throw new Error('identity not persisted');
    await writeFile(join(userData,'identity-persisted'),'done');
  });
  const initial = await store.legacyLaunch(); await writeFile(join(initial.dshHome,'records'),'committed');
  await store.reconcile({kind:'guest'});
  await expect(store.launch()).rejects.toThrow('identity not persisted');
  expect(await readFile(join(initial.dshHome,'records'),'utf8')).toBe('committed');
  allowed = true;
  const final = await store.launch();
  expect(calls).toBe(2);
  expect(await readFile(join(userData,'identity-persisted'),'utf8')).toBe('done');
  expect(await readFile(join(final.dshHome,'records'),'utf8')).toBe('committed');
});


test('replays identity persistence after a crash following rename but before registry completion', async () => {
  const userData = await makeTempDirectory('account-scope-renamed-recovery-');
  const first = new DshAccountScopeStore(userData, ()=>'scope_recovery_01');
  const legacy = await first.legacyLaunch(); await writeFile(join(legacy.dshHome,'records'),'committed');
  const pending = await first.reconcile({kind:'guest'});
  await mkdir(join(userData,'dsh-containers','scope_recovery_01'),{recursive:true});
  await rename(legacy.dshHome,pending.launch.dshHome);
  let transferred = false;
  const resumed = new DshAccountScopeStore(userData,undefined,async (source,target)=>{
    expect(source).toBe(legacy.dshHome); expect(target).toBe(pending.launch.dshHome);
    expect(await readFile(join(target,'records'),'utf8')).toBe('committed');
    transferred = true;
  });
  const recovered = await resumed.launch({deferLegacyMigration:true});
  expect(transferred).toBe(true);
  expect(recovered.dshHome).toBe(pending.launch.dshHome);
  expect(JSON.parse(await readFile(join(userData,'dsh-account-scopes.json'),'utf8'))).not.toHaveProperty('pendingLegacy');
});

test('defers a historical pending legacy rename until after the new runtime snapshot and trial', async () => {
  const userData = await makeTempDirectory('account-scope-initial-pending-');
  const previous = new DshAccountScopeStore(userData, () => 'scope_historical_01');
  const legacy = await previous.legacyLaunch();
  await writeFile(join(legacy.dshHome,'records'),'original');
  const pending = await previous.reconcile({kind:'guest'});
  const resumed = new DshAccountScopeStore(userData);
  const trial = await resumed.launch({deferLegacyMigration:true});
  expect(trial.containerRef).toBe('legacy');
  expect(trial.dshHome).toBe(legacy.dshHome);
  const snapshot = await readFile(join(trial.dshHome,'records'),'utf8');
  expect(snapshot).toBe('original');
  await writeFile(join(trial.dshHome,'records'),'committed-trial');
  const committed = await resumed.launch();
  expect(committed.dshHome).toBe(pending.launch.dshHome);
  expect(await readFile(join(committed.dshHome,'records'),'utf8')).toBe('committed-trial');
});
