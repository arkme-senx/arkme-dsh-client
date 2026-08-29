import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  activateOptionalExtensionRecovery,
  enforceActiveOptionalExtensionRecoveries,
  loadPendingOptionalExtensionRecovery,
  prepareOptionalExtensionRecovery,
  restoreOptionalExtensionRecovery
} from "../src/optional-extension-recovery.js";

const RUNTIME_RELEASE_ID = "electron-runtime-v1-0123456789abcdef0123456789abcdef";

interface ProfileFixture {
  dshHome: string;
  profilePath: string;
  peerSource: string;
  originalText: string;
}

async function createProfileFixture(prefix = "arkme-optional-recovery-"): Promise<ProfileFixture> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const dshHome = path.join(root, "dsh");
  const profileDirectory = path.join(dshHome, "profiles", "web");
  const peerSource = path.join(root, "development", "dsh-arkme-peer-portrait");
  await Promise.all([
    mkdir(profileDirectory, { recursive: true }),
    mkdir(peerSource, { recursive: true })
  ]);
  const profile = {
    name: "dsh-profile-web",
    private: true,
    dependencies: {
      "@deepseek-ai/dsh-base": "0.1.1-rc.2",
      "@senguoyun/dsh-arkme": "link:/runtime/dsh-arkme",
      "@senguoyun/dsh-arkme-peer-portrait": `link:${peerSource}`,
      "@example/registry-extension": "1.2.3",
      "@example/local-a": "link:../local-a",
      "@example/local-b": "file:../local-b",
      "@example/disabled-local": "link:../disabled-local"
    },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@senguoyun/dsh-arkme",
          "@senguoyun/dsh-arkme-peer-portrait",
          "@example/registry-extension",
          "@example/local-a",
          "@example/local-b"
        ]
      }
    }
  };
  const originalText = `${JSON.stringify(profile, undefined, 2)}\n`;
  const profilePath = path.join(profileDirectory, "package.json");
  await writeFile(profilePath, originalText, { mode: 0o600 });
  return { dshHome, profilePath, peerSource, originalText };
}

async function bundles(profilePath: string): Promise<string[]> {
  const profile = JSON.parse(await readFile(profilePath, "utf8")) as {
    dsh: { profile: { bundles: string[] } };
  };
  return profile.dsh.profile.bundles;
}

describe("optional extension startup recovery", () => {
  test("quarantines the optional importer when its protected Arkme dependency cannot resolve", async () => {
    const fixture = await createProfileFixture();
    const failureText = [
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@senguoyun/dsh-arkme'",
      `imported from ${path.join(fixture.peerSource, "lib", "index.js")}`,
      "Cordis bundle loader failed"
    ].join("\n");

    const transaction = await prepareOptionalExtensionRecovery({
      dshHome: fixture.dshHome,
      environment: "test",
      runtimeReleaseId: RUNTIME_RELEASE_ID,
      failureText
    });

    expect(transaction?.receipt.mode).toBe("targeted");
    expect(transaction?.receipt.entries.map((item) => item.packageName)).toEqual([
      "@senguoyun/dsh-arkme-peer-portrait"
    ]);
    expect(await bundles(fixture.profilePath)).toEqual([
      "@deepseek-ai/dsh-base",
      "@senguoyun/dsh-arkme",
      "@example/registry-extension",
      "@example/local-a",
      "@example/local-b"
    ]);
    expect(JSON.parse(await readFile(transaction!.receiptPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      environment: "test",
      phase: "pending",
      runtimeReleaseId: RUNTIME_RELEASE_ID
    });
    expect((await stat(transaction!.receiptPath)).mode & 0o777).toBe(0o600);
  });

  test("uses local safe mode when a Bundle loader failure cannot identify one extension", async () => {
    const fixture = await createProfileFixture();

    const transaction = await prepareOptionalExtensionRecovery({
      dshHome: fixture.dshHome,
      environment: "prod",
      failureText: "Cordis bundle loader failed while applying the current Profile"
    });

    expect(transaction?.receipt.mode).toBe("local-safe-mode");
    expect(transaction?.receipt.entries.map((item) => item.packageName)).toEqual([
      "@senguoyun/dsh-arkme-peer-portrait",
      "@example/local-a",
      "@example/local-b"
    ]);
    expect(await bundles(fixture.profilePath)).toEqual([
      "@deepseek-ai/dsh-base",
      "@senguoyun/dsh-arkme",
      "@example/registry-extension"
    ]);
  });

  test("does not modify the Profile for core-only, network, or non-plugin module failures", async () => {
    for (const failureText of [
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@senguoyun/dsh-arkme' imported from /runtime/dsh/lib/index.js",
      "fetch failed: connect ECONNREFUSED 127.0.0.1:443",
      "Cannot find module ./main.js while starting Electron"
    ]) {
      const fixture = await createProfileFixture();
      const result = await prepareOptionalExtensionRecovery({
        dshHome: fixture.dshHome,
        environment: "prod",
        failureText
      });
      expect(result).toBeUndefined();
      expect(await readFile(fixture.profilePath, "utf8")).toBe(fixture.originalText);
    }
  });

  test("restores the exact Profile bytes when the recovery retry fails", async () => {
    const fixture = await createProfileFixture();
    const transaction = await prepareOptionalExtensionRecovery({
      dshHome: fixture.dshHome,
      environment: "prod",
      failureText: `Cannot find module imported from ${path.join(fixture.peerSource, "index.js")}`
    });
    expect(transaction).toBeDefined();

    await restoreOptionalExtensionRecovery(transaction!);

    expect(await readFile(fixture.profilePath, "utf8")).toBe(fixture.originalText);
    expect(JSON.parse(await readFile(transaction!.receiptPath, "utf8"))).toMatchObject({
      phase: "restored"
    });
  });

  test("resumes a pending transaction after a process exit and activates it after success", async () => {
    const fixture = await createProfileFixture();
    const prepared = await prepareOptionalExtensionRecovery({
      dshHome: fixture.dshHome,
      environment: "test",
      failureText: `Bundle failed to load ${path.join(fixture.peerSource, "index.js")}`
    });
    expect(prepared).toBeDefined();

    const resumed = await loadPendingOptionalExtensionRecovery({
      dshHome: fixture.dshHome,
      environment: "test",
      runtimeReleaseId: RUNTIME_RELEASE_ID
    });
    expect(resumed?.receipt.quarantineId).toBe(prepared?.receipt.quarantineId);

    await activateOptionalExtensionRecovery(resumed!);

    expect(JSON.parse(await readFile(resumed!.receiptPath, "utf8"))).toMatchObject({
      phase: "active"
    });
    expect(await bundles(fixture.profilePath)).not.toContain("@senguoyun/dsh-arkme-peer-portrait");
  });

  test("re-applies an active quarantine after a runtime Profile rollback restores the old manifest", async () => {
    const fixture = await createProfileFixture();
    const transaction = await prepareOptionalExtensionRecovery({
      dshHome: fixture.dshHome,
      environment: "test",
      failureText: `Bundle failed to load ${path.join(fixture.peerSource, "index.js")}`
    });
    await activateOptionalExtensionRecovery(transaction!);
    await writeFile(fixture.profilePath, fixture.originalText);

    const packages = await enforceActiveOptionalExtensionRecoveries({
      dshHome: fixture.dshHome,
      environment: "test"
    });

    expect(packages).toEqual(["@senguoyun/dsh-arkme-peer-portrait"]);
    expect(await bundles(fixture.profilePath)).not.toContain("@senguoyun/dsh-arkme-peer-portrait");
  });

  test("allows an explicit manual re-enable intent to pass the startup convergence gate", async () => {
    const fixture = await createProfileFixture();
    const transaction = await prepareOptionalExtensionRecovery({
      dshHome: fixture.dshHome,
      environment: "test",
      failureText: `Bundle failed to load ${path.join(fixture.peerSource, "index.js")}`
    });
    await activateOptionalExtensionRecovery(transaction!);
    const receipt = JSON.parse(await readFile(transaction!.receiptPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    receipt.entries[0]!.reenableRequestedAtMillis = 1_787_900_000_000;
    await writeFile(transaction!.receiptPath, `${JSON.stringify(receipt, undefined, 2)}\n`);
    await writeFile(fixture.profilePath, fixture.originalText);

    const packages = await enforceActiveOptionalExtensionRecoveries({
      dshHome: fixture.dshHome,
      environment: "test"
    });

    expect(packages).toEqual([]);
    expect(await bundles(fixture.profilePath)).toContain("@senguoyun/dsh-arkme-peer-portrait");
  });

  test("does not read a pending receipt from the other environment root", async () => {
    const prod = await createProfileFixture("arkme-prod-recovery-");
    const testEnvironment = await createProfileFixture("arkme-test-recovery-");
    await prepareOptionalExtensionRecovery({
      dshHome: prod.dshHome,
      environment: "prod",
      failureText: `Bundle failed to load ${path.join(prod.peerSource, "index.js")}`
    });

    const pending = await loadPendingOptionalExtensionRecovery({
      dshHome: testEnvironment.dshHome,
      environment: "test"
    });

    expect(pending).toBeUndefined();
    await expect(access(path.join(
      testEnvironment.dshHome,
      "arkme-self",
      "desktop-extension-quarantine"
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("leaves the Profile byte-identical when the transaction directory cannot be created", async () => {
    const fixture = await createProfileFixture();
    const arkmeSelfPath = path.join(fixture.dshHome, "arkme-self");
    await writeFile(arkmeSelfPath, "not a directory");

    await expect(prepareOptionalExtensionRecovery({
      dshHome: fixture.dshHome,
      environment: "prod",
      failureText: `Bundle failed to load ${path.join(fixture.peerSource, "index.js")}`
    })).rejects.toThrow();

    expect(await readFile(fixture.profilePath, "utf8")).toBe(fixture.originalText);
  });
});
