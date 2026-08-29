import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BadRuntimeReleaseBlockedError,
  ElectronRuntimeManager
} from "../src/runtime/manager.js";
import { deriveElectronRuntimeReleaseId, type ElectronRuntimeManifest } from "../src/runtime/manifest.js";
import { RuntimeArtifactValidationError } from "../src/runtime/errors.js";

const temporaryDirectories: string[] = [];
const manifestContext = { os: "darwin", arch: "arm64", shellVersion: "0.2.0", electronMajor: 43, modulesAbi: 148 } as const;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function release(_id: string, harnessCode: number, pluginCode: number): ElectronRuntimeManifest {
  const manifest: ElectronRuntimeManifest = {
    schemaVersion: 1,
    releaseId: _id,
    channel: "stable",
    publishedAt: "2026-08-27T00:00:00Z",
    target: { os: "darwin", arch: "arm64" },
    minShellVersion: "0.2.0",
    runtimeApiVersion: 1,
    dataSchemaVersion: 1,
    electron: { major: 43, modulesAbi: 148 },
    pnpmVersion: "11.19.0",
    artifacts: {
      harness: { version: "0.1.0-rc.8", versionCode: harnessCode, modulesAbi: 148, url: "https://d.jiwo.cc/harness.tar.zst", sha256: `${harnessCode}`.repeat(64), size: 1, unpackedSize: 1, entry: "harness/node_modules/@deepseek-ai/dsh/lib/bin.js", metadata: "harness/runtime-metadata.json" },
      requiredPlugin: { version: "0.1.18", versionCode: pluginCode, url: "https://d.jiwo.cc/plugin.tar.zst", sha256: `${pluginCode}`.repeat(64), size: 1, unpackedSize: 1, name: "@senguoyun/dsh-arkme", target: "harness/node_modules/@senguoyun/dsh-arkme" }
    }
  };
  manifest.releaseId = deriveElectronRuntimeReleaseId(manifest);
  return manifest;
}

async function installFixture(manifest: ElectronRuntimeManifest, stagingPath: string): Promise<void> {
  await mkdir(path.join(stagingPath, "harness", "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  await mkdir(path.join(stagingPath, "harness", "node_modules", "@senguoyun", "dsh-arkme", "lib"), { recursive: true });
  await mkdir(path.join(stagingPath, "harness", "node_modules", ".bin"), { recursive: true });
  await mkdir(path.join(stagingPath, "harness", "node_modules", "pnpm", "bin"), { recursive: true });
  await writeFile(path.join(stagingPath, "harness", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "dsh");
  await writeFile(path.join(stagingPath, "harness", "node_modules", "@senguoyun", "dsh-arkme", "package.json"), JSON.stringify({ name: "@senguoyun/dsh-arkme", version: manifest.artifacts.requiredPlugin.version }));
  await writeFile(path.join(stagingPath, "harness", "node_modules", "@senguoyun", "dsh-arkme", "lib", "index.js"), "plugin");
  await writeFile(path.join(stagingPath, "harness", "node_modules", "pnpm", "bin", "pnpm.cjs"), "pnpm");
}

function createManager(
  root: string,
  fetchManifest: () => Promise<ElectronRuntimeManifest>,
  installed: string[] = []
): ElectronRuntimeManager {
  return new ElectronRuntimeManager({
    root,
    environment: "prod",
    manifestContext,
    fetchManifest,
    installRelease: async (manifest, stagingPath) => {
      installed.push(manifest.releaseId);
      await installFixture(manifest, stagingPath);
    },
    validateRelease: async () => undefined,
    now: () => new Date("2026-08-27T00:00:00Z")
  });
}

function dshEntry(root: string, releaseId: string): string {
  return path.join(root, "releases", releaseId, "harness", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
}

describe("ElectronRuntimeManager", () => {
  test("installs the first online release, stages updates, and activates them only on the next start", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-manager-"));
    temporaryDirectories.push(root);
    let latest = release("electron-runtime-v1-11111111111111111111111111111111", 1, 1);
    const installed: string[] = [];
    let validations = 0;
    const dependencies = {
      environment: "prod" as const,
      manifestContext,
      fetchManifest: async () => latest,
      installRelease: async (manifest: ElectronRuntimeManifest, stagingPath: string) => {
        installed.push(manifest.releaseId);
        await installFixture(manifest, stagingPath);
      },
      validateRelease: async () => { validations += 1; },
      now: () => new Date("2026-08-27T00:00:00Z")
    };
		await mkdir(path.join(root, "staging", "orphan"), { recursive: true });
		await writeFile(path.join(root, "staging", "orphan", "partial"), "partial");

    const manager = new ElectronRuntimeManager({ root, ...dependencies });
    const first = await manager.prepareForLaunch();
    expect(first.releaseId).toBe(latest.releaseId);
    expect(first.probation).toBe(true);
		expect((JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as { activeReleaseId?: string; candidateReleaseId?: string })).toMatchObject({
			candidateReleaseId: first.releaseId
		});
		await manager.completeCandidate();
		await expect(access(path.join(root, "staging", "orphan"))).rejects.toMatchObject({ code: "ENOENT" });

    latest = release("electron-runtime-v1-22222222222222222222222222222222", 2, 1);
    expect(await manager.stageLatest()).toBe("staged");
    expect((JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as { activeReleaseId: string; candidateReleaseId: string })).toMatchObject({
      activeReleaseId: first.releaseId,
      candidateReleaseId: latest.releaseId
    });

    const staged = latest;
    latest = release("electron-runtime-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 1, 2);
    expect(await manager.stageLatest()).toBe("stale");
    expect((JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as { candidateReleaseId: string }).candidateReleaseId).toBe(staged.releaseId);
    latest = staged;

    const restarted = new ElectronRuntimeManager({ root, ...dependencies });
    const second = await restarted.prepareForLaunch();
    expect(second.releaseId).toBe(latest.releaseId);
    expect(second.probation).toBe(true);
    expect(installed).toEqual([first.releaseId, second.releaseId]);
		expect(validations).toBeGreaterThanOrEqual(4);

    await mkdir(path.join(root, "releases", "orphan-release"), { recursive: true });
    await mkdir(path.join(root, "downloads"), { recursive: true });
    await writeFile(path.join(root, "downloads", "unused.tar.zst"), "unused");

    const rolledBack = await restarted.rollbackCandidate({
      phase: "plugin-health",
      scope: "unknown",
      code: "PLUGIN_HEALTH_FAILED",
      reason: "health failed"
    });
    expect(rolledBack?.releaseId).toBe(first.releaseId);
		const rolledBackState = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as {
			badReleases: unknown[];
			deferredReleases: Array<{ releaseId: string }>;
		};
		expect(rolledBackState.badReleases).toEqual([]);
		expect(rolledBackState.deferredReleases).toContainEqual(expect.objectContaining({ releaseId: second.releaseId }));
    await expect(access(path.join(root, "releases", "orphan-release"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(root, "downloads", "unused.tar.zst"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("commits successful probation even when best-effort cache cleanup fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-cleanup-"));
    temporaryDirectories.push(root);
    const latest = release("electron-runtime-v1-33333333333333333333333333333333", 3, 3);
    const manager = new ElectronRuntimeManager({
      root,
      environment: "prod",
      manifestContext,
      fetchManifest: async () => latest,
      installRelease: installFixture,
      validateRelease: async () => undefined
    });

    await manager.prepareForLaunch();
    await writeFile(path.join(root, "downloads"), "not-a-directory");
    await expect(manager.completeCandidate()).resolves.toBeUndefined();
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as { candidateReleaseId?: string };
    expect(state.candidateReleaseId).toBeUndefined();
  });

  test("quarantines a probation release whose stored artifact identity was tampered", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-tampered-"));
    temporaryDirectories.push(root);
    const latest = release("electron-runtime-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1, 1);
    const manager = createManager(root, async () => latest);
    const active = await manager.prepareForLaunch();
    const manifestPath = path.join(root, "releases", active.releaseId, "release.json");
    const tampered = JSON.parse(await readFile(manifestPath, "utf8")) as ElectronRuntimeManifest;
    tampered.artifacts.harness.entry = "release.json";
    await writeFile(manifestPath, JSON.stringify(tampered));

    await expect(manager.prepareForLaunch()).rejects.toBeInstanceOf(BadRuntimeReleaseBlockedError);
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as { badReleases: Array<{ releaseId: string }> };
    expect(state.badReleases).toContainEqual(expect.objectContaining({ releaseId: active.releaseId }));
  });

  test("rolls back a corrupt probation release before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-corrupt-probation-"));
    temporaryDirectories.push(root);
    let latest = release("electron-runtime-v1-44444444444444444444444444444444", 4, 4);
    const manager = createManager(root, async () => latest);
    const first = await manager.prepareForLaunch();
    await manager.completeCandidate();
    latest = release("electron-runtime-v1-55555555555555555555555555555555", 5, 4);
    await manager.stageLatest();
    const probation = await manager.prepareForLaunch();
    await rm(dshEntry(root, probation.releaseId));

    const recovered = await createManager(root, async () => latest).prepareForLaunch();
    expect(recovered.releaseId).toBe(first.releaseId);
    expect(recovered.probation).toBe(false);
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as { badReleases: Array<{ releaseId: string }> };
    expect(state.badReleases).toContainEqual(expect.objectContaining({ releaseId: probation.releaseId }));
  });

  test("defers a candidate filesystem permission failure without marking or deleting it as Bad", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-permission-failure-"));
    temporaryDirectories.push(root);
    let latest = release("electron-runtime-v1-44444444444444444444444444444444", 4, 4);
    let deniedReleaseId: string | undefined;
    let deniedValidationCount = 0;
    const dependencies = {
      environment: "prod" as const,
      manifestContext,
      fetchManifest: async () => latest,
      installRelease: installFixture,
      validateRelease: async (_manifest: ElectronRuntimeManifest, releasePath: string) => {
        if (path.basename(releasePath) === deniedReleaseId) {
          deniedValidationCount += 1;
          if (deniedValidationCount > 1) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
        }
      }
    };
    const manager = new ElectronRuntimeManager({ root, ...dependencies });
    const stable = await manager.prepareForLaunch();
    await manager.completeCandidate();
    latest = release("electron-runtime-v1-55555555555555555555555555555555", 5, 4);
    deniedReleaseId = latest.releaseId;
    await manager.stageLatest();

    const recovered = await new ElectronRuntimeManager({ root, ...dependencies }).prepareForLaunch();

    expect(recovered.releaseId).toBe(stable.releaseId);
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as {
      badReleases: unknown[];
      deferredReleases: Array<{ releaseId: string; scope: string }>;
    };
    expect(state.badReleases).toEqual([]);
    expect(state.deferredReleases).toContainEqual(expect.objectContaining({
      releaseId: latest.releaseId,
      scope: "environment"
    }));
    await expect(access(path.join(root, "releases", latest.releaseId))).resolves.toBeUndefined();
  });

  test("quarantines a candidate only for an explicit artifact validation error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-explicit-artifact-error-"));
    temporaryDirectories.push(root);
    const latest = release("electron-runtime-v1-66666666666666666666666666666666", 6, 6);
    let validationCount = 0;
    const manager = new ElectronRuntimeManager({
      root,
      environment: "prod",
      manifestContext,
      fetchManifest: async () => latest,
      installRelease: installFixture,
      validateRelease: async () => {
        validationCount += 1;
        if (validationCount > 1) {
          throw new RuntimeArtifactValidationError("ABI_MISMATCH", "native module ABI mismatch", "verify");
        }
      }
    });

    await expect(manager.prepareForLaunch()).rejects.toBeInstanceOf(BadRuntimeReleaseBlockedError);
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as {
      badReleases: Array<{ code: string }>;
    };
    expect(state.badReleases).toContainEqual(expect.objectContaining({ code: "ABI_MISMATCH" }));
  });

  test("reinstalls a corrupt stable release online", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-corrupt-stable-"));
    temporaryDirectories.push(root);
    const latest = release("electron-runtime-v1-66666666666666666666666666666666", 6, 6);
    const installed: string[] = [];
    const manager = createManager(root, async () => latest, installed);
    const active = await manager.prepareForLaunch();
    await manager.completeCandidate();
    await rm(dshEntry(root, active.releaseId));

    const reinstalled = await createManager(root, async () => latest, installed).prepareForLaunch();
    expect(reinstalled.releaseId).toBe(active.releaseId);
    expect(reinstalled.probation).toBe(true);
    expect(installed).toEqual([active.releaseId, active.releaseId]);
  });

  test("clears a corrupt stable release before surfacing an offline reinstall failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-corrupt-offline-"));
    temporaryDirectories.push(root);
    const latest = release("electron-runtime-v1-77777777777777777777777777777777", 7, 7);
    const manager = createManager(root, async () => latest);
    const active = await manager.prepareForLaunch();
    await manager.completeCandidate();
    await rm(dshEntry(root, active.releaseId));

    await expect(createManager(root, async () => { throw new Error("offline"); }).prepareForLaunch()).rejects.toThrow("offline");
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as { activeReleaseId?: string };
    expect(state.activeReleaseId).toBeUndefined();
  });

  test("falls back to online recovery when both probation and previous releases are corrupt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-corrupt-fallback-"));
    temporaryDirectories.push(root);
    let latest = release("electron-runtime-v1-88888888888888888888888888888888", 8, 8);
    const manager = createManager(root, async () => latest);
    const first = await manager.prepareForLaunch();
    await manager.completeCandidate();
    latest = release("electron-runtime-v1-99999999999999999999999999999999", 9, 8);
    await manager.stageLatest();
    const probation = await manager.prepareForLaunch();
    await Promise.all([rm(dshEntry(root, first.releaseId)), rm(dshEntry(root, probation.releaseId))]);

    await expect(createManager(root, async () => { throw new Error("offline"); }).prepareForLaunch()).rejects.toThrow("offline");
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as { activeReleaseId?: string; badReleases: Array<{ releaseId: string }> };
    expect(state.activeReleaseId).toBeUndefined();
    expect(state.badReleases).toContainEqual(expect.objectContaining({ releaseId: probation.releaseId }));
  });

  test("keeps active and fallback releases when fallback validation fails for an environment reason", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-fallback-permission-"));
    temporaryDirectories.push(root);
    let latest = release("electron-runtime-v1-89898989898989898989898989898989", 8, 8);
    const manager = createManager(root, async () => latest);
    const previous = await manager.prepareForLaunch();
    await manager.completeCandidate();
    latest = release("electron-runtime-v1-90909090909090909090909090909090", 9, 8);
    await manager.stageLatest();
    const active = await manager.prepareForLaunch();
    await manager.completeCandidate();
    await rm(dshEntry(root, active.releaseId));

    const recovering = new ElectronRuntimeManager({
      root,
      environment: "prod",
      manifestContext,
      fetchManifest: async () => latest,
      installRelease: installFixture,
      validateRelease: async (_manifest, releasePath) => {
        if (path.basename(releasePath) === previous.releaseId) {
          throw Object.assign(new Error("fallback permission denied"), { code: "EACCES" });
        }
      }
    });

    await expect(recovering.prepareForLaunch()).rejects.toMatchObject({ code: "EACCES" });
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as {
      activeReleaseId?: string;
      previousReleaseId?: string;
      badReleases: unknown[];
      launchFailures: Array<{ releaseId: string; scope: string }>;
    };
    expect(state).toMatchObject({
      activeReleaseId: active.releaseId,
      previousReleaseId: previous.releaseId,
      badReleases: []
    });
    expect(state.launchFailures).toContainEqual(expect.objectContaining({
      releaseId: previous.releaseId,
      scope: "environment"
    }));
    await expect(access(path.join(root, "releases", active.releaseId))).resolves.toBeUndefined();
    await expect(access(path.join(root, "releases", previous.releaseId))).resolves.toBeUndefined();
  });

  test("never reuses a production release or state when the same root is opened by the test environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-environment-boundary-"));
    temporaryDirectories.push(root);
    const latest = release("electron-runtime-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 2, 2);
    const production = createManager(root, async () => latest);
    await production.prepareForLaunch();
    await production.completeCandidate();

    const testInstalls: string[] = [];
    const testing = new ElectronRuntimeManager({
      root,
      environment: "test",
      manifestContext,
      fetchManifest: async () => latest,
      installRelease: async (manifest, stagingPath) => {
        testInstalls.push(manifest.releaseId);
        await installFixture(manifest, stagingPath);
      },
      validateRelease: async () => undefined
    });

    await testing.prepareForLaunch();

    expect(testInstalls).toEqual([latest.releaseId]);
    expect(JSON.parse(await readFile(
      path.join(root, "releases", latest.releaseId, "runtime-environment.json"),
      "utf8"
    ))).toEqual({ schemaVersion: 1, environment: "test" });
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8")))
      .toMatchObject({ schemaVersion: 2, environment: "test", candidateReleaseId: latest.releaseId });
  });

  test("adopts an unmarked schema v1 release only into the environment that owns its user-data root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-v1-adoption-"));
    temporaryDirectories.push(root);
    const latest = release("electron-runtime-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 3, 3);
    const releasePath = path.join(root, "releases", latest.releaseId);
    await installFixture(latest, releasePath);
    await writeFile(path.join(releasePath, "release.json"), JSON.stringify(latest));
    await writeFile(path.join(root, "state.json"), JSON.stringify({
      schemaVersion: 1,
      activeReleaseId: latest.releaseId,
      badReleases: []
    }));

    const resolved = await createManager(root, async () => latest).prepareForLaunch();

    expect(resolved.releaseId).toBe(latest.releaseId);
    expect(resolved.probation).toBe(false);
    expect(JSON.parse(await readFile(path.join(releasePath, "runtime-environment.json"), "utf8")))
      .toEqual({ schemaVersion: 1, environment: "prod" });
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8")))
      .toMatchObject({ schemaVersion: 2, environment: "prod", activeReleaseId: latest.releaseId });
  });

  test("defers an interrupted candidate on the next process start instead of retrying it automatically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-interrupted-candidate-"));
    temporaryDirectories.push(root);
    let latest = release("electron-runtime-v1-cccccccccccccccccccccccccccccccc", 4, 4);
    const manager = createManager(root, async () => latest);
    const stable = await manager.prepareForLaunch();
    await manager.completeCandidate();
    latest = release("electron-runtime-v1-dddddddddddddddddddddddddddddddd", 5, 4);
    await manager.stageLatest();
    const attempted = await manager.prepareForLaunch();
    expect(attempted.releaseId).toBe(latest.releaseId);

    const recovered = await createManager(root, async () => latest).prepareForLaunch();

    expect(recovered.releaseId).toBe(stable.releaseId);
    expect(recovered.probation).toBe(false);
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as {
      badReleases: unknown[];
      deferredReleases: Array<{ releaseId: string; code: string }>;
    };
    expect(state.badReleases).toEqual([]);
    expect(state.deferredReleases).toContainEqual(expect.objectContaining({
      releaseId: latest.releaseId,
      code: "CANDIDATE_START_INTERRUPTED"
    }));
  });

  test("reloads the current environment once without clearing Bad until the candidate is healthy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-manual-reload-"));
    temporaryDirectories.push(root);
    const latest = release("electron-runtime-v1-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", 6, 6);
    const installed: string[] = [];
    const manager = createManager(root, async () => latest, installed);
    const candidate = await manager.prepareForLaunch();
    await writeFile(
      path.join(root, "releases", candidate.releaseId, "release.json"),
      "{}"
    );
    await expect(manager.prepareForLaunch()).rejects.toBeInstanceOf(BadRuntimeReleaseBlockedError);
    await mkdir(path.join(root, "downloads"), { recursive: true });
    await writeFile(path.join(root, "downloads", `${latest.artifacts.harness.sha256}.tar.zst`), "stale harness");
    await writeFile(path.join(root, "downloads", `${latest.artifacts.requiredPlugin.sha256}.tar.zst`), "stale plugin");

    const reloaded = await manager.reloadCurrentEnvironment();

    expect(reloaded.releaseId).toBe(latest.releaseId);
    expect(installed).toEqual([latest.releaseId, latest.releaseId]);
    const beforeHealth = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as {
      candidateReleaseId?: string;
      badReleases: Array<{ releaseId: string }>;
    };
    expect(beforeHealth.candidateReleaseId).toBe(latest.releaseId);
    expect(beforeHealth.badReleases).toContainEqual(expect.objectContaining({ releaseId: latest.releaseId }));

    await manager.completeCandidate();

    const healthy = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as {
      activeReleaseId?: string;
      badReleases: Array<{ releaseId: string }>;
    };
    expect(healthy.activeReleaseId).toBe(latest.releaseId);
    expect(healthy.badReleases).toEqual([]);
  });

  test("keeps the current environment blocked and reloadable when a manual download retry fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-manual-reload-failure-"));
    temporaryDirectories.push(root);
    const latest = release("electron-runtime-v1-ffffffffffffffffffffffffffffffff", 7, 7);
    let failInstall = false;
    const manager = new ElectronRuntimeManager({
      root,
      environment: "test",
      manifestContext,
      fetchManifest: async () => latest,
      installRelease: async (manifest, stagingPath) => {
        if (failInstall) throw new Error("temporary OSS failure");
        await installFixture(manifest, stagingPath);
      },
      validateRelease: async () => undefined
    });
    const candidate = await manager.prepareForLaunch();
    await writeFile(path.join(candidate.releasePath, "release.json"), "{}");
    await expect(manager.prepareForLaunch()).rejects.toBeInstanceOf(BadRuntimeReleaseBlockedError);
    failInstall = true;

    await expect(manager.reloadCurrentEnvironment()).rejects.toMatchObject({
      name: "BadRuntimeReleaseBlockedError",
      showReloadRuntimeAction: true,
      environment: "test"
    });
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as {
      badReleases: Array<{ releaseId: string }>;
    };
    expect(state.badReleases).toContainEqual(expect.objectContaining({ releaseId: latest.releaseId }));
  });

  test("reloads only runtime code without touching current or other environment user data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-data-isolation-"));
    temporaryDirectories.push(root);
    const productionUserData = path.join(root, "Arkme Harness");
    const testUserData = path.join(root, "Arkme Harness Test");
    const productionData = path.join(productionUserData, "dsh", "arkme-self", "marketplace-extension.json");
    const testData = path.join(testUserData, "dsh", "arkme-self", "draft.json");
    const testSettings = path.join(testUserData, "settings.json");
    await mkdir(path.dirname(productionData), { recursive: true });
    await mkdir(path.dirname(testData), { recursive: true });
    await Promise.all([
      writeFile(productionData, "production marketplace plugin"),
      writeFile(testData, "test draft"),
      writeFile(testSettings, "test settings")
    ]);
    const before = await Promise.all([productionData, testData, testSettings].map(async file => ({
      content: await readFile(file, "utf8"),
      mtimeMs: (await stat(file)).mtimeMs
    })));
    const latest = release("electron-runtime-v1-abababababababababababababababab", 8, 8);
    const manager = new ElectronRuntimeManager({
      root: path.join(testUserData, "runtime-manager", "electron-v1"),
      environment: "test",
      manifestContext,
      fetchManifest: async () => latest,
      installRelease: installFixture,
      validateRelease: async () => undefined
    });
    const candidate = await manager.prepareForLaunch();
    await writeFile(path.join(candidate.releasePath, "release.json"), "{}");
    await expect(manager.prepareForLaunch()).rejects.toBeInstanceOf(BadRuntimeReleaseBlockedError);

    await manager.reloadCurrentEnvironment();
    await manager.completeCandidate();

    const after = await Promise.all([productionData, testData, testSettings].map(async file => ({
      content: await readFile(file, "utf8"),
      mtimeMs: (await stat(file)).mtimeMs
    })));
    expect(after).toEqual(before);
    await expect(access(path.join(productionUserData, "runtime-manager"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
