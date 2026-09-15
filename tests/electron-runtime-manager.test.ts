import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BadRuntimeReleaseBlockedError,
  ElectronRuntimeManager
} from "../src/runtime/manager.js";
import { deriveElectronRuntimeReleaseId, type ElectronRuntimeManifest } from "../src/runtime/manifest.js";
import { RuntimeArtifactValidationError } from "../src/runtime/errors.js";
import { AUTOMATIC_UPDATE_CHECK_INTERVAL_MS } from "../src/update-check-policy.js";

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
  fetchManifest: (baseline?: ElectronRuntimeManifest) => Promise<ElectronRuntimeManifest>,
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
  test("passes the active and pending releases as compatible-feed baselines while staging", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-compatible-baseline-"));
    temporaryDirectories.push(root);
    const current = release("electron-runtime-v1-compatible-current", 1, 1);
    const pending = release("electron-runtime-v1-compatible-pending", 2, 2);
    let next = current;
    const baselines: Array<ElectronRuntimeManifest | undefined> = [];
    const manager = new ElectronRuntimeManager({
      root,
      environment: "prod",
      manifestContext,
      fetchManifest: async (baseline?: ElectronRuntimeManifest) => {
        baselines.push(baseline);
        return next;
      },
      installRelease: installFixture,
      validateRelease: async () => undefined
    });

    await manager.prepareForLaunch();
    await manager.completeCandidate();
    next = pending;
    await expect(manager.stageLatest()).resolves.toBe("staged");
    next = pending;
    await expect(manager.stageLatest()).resolves.toBe("staged");

    expect(baselines).toEqual([undefined, current, pending]);
  });

  test("counts the bootstrap manifest request toward the background update cooldown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-bootstrap-cooldown-"));
    temporaryDirectories.push(root);
    let nowMillis = Date.parse("2026-08-27T00:00:00Z");
    let latest = release("electron-runtime-v1-bootstrap", 1, 1);
    let fetches = 0;
    const manager = new ElectronRuntimeManager({
      root,
      environment: "prod",
      manifestContext,
      fetchManifest: async () => {
        fetches += 1;
        return latest;
      },
      installRelease: installFixture,
      validateRelease: async () => undefined,
      now: () => new Date(nowMillis)
    });

    await manager.prepareForLaunch();
    await manager.completeCandidate();
    expect(await manager.stageLatestIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS)).toBe("throttled");
    expect(fetches).toBe(1);

    latest = release("electron-runtime-v1-newer", 2, 1);
    nowMillis += 30 * 60_000 - 1;
    expect(await manager.stageLatestIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS)).toBe("throttled");
    expect(fetches).toBe(1);

    nowMillis += 1;
    expect(await manager.stageLatestIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS)).toBe("staged");
    expect(fetches).toBe(2);
  });

  test("coalesces concurrent stale checks into one Release Set request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-single-flight-"));
    temporaryDirectories.push(root);
    let nowMillis = Date.parse("2026-08-27T00:00:00Z");
    const current = release("electron-runtime-v1-current", 1, 1);
    let fetches = 0;
    let finishRequest: ((manifest: ElectronRuntimeManifest) => void) | undefined;
    const manager = new ElectronRuntimeManager({
      root,
      environment: "prod",
      manifestContext,
      fetchManifest: async () => {
        fetches += 1;
        if (fetches === 1) return current;
        return await new Promise<ElectronRuntimeManifest>(resolve => { finishRequest = resolve; });
      },
      installRelease: installFixture,
      validateRelease: async () => undefined,
      now: () => new Date(nowMillis)
    });

    await manager.prepareForLaunch();
    await manager.completeCandidate();
    nowMillis += AUTOMATIC_UPDATE_CHECK_INTERVAL_MS;
    const first = manager.stageLatestIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    const second = manager.stageLatestIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    await vi.waitFor(() => expect(fetches).toBe(2));

    finishRequest?.(current);
    await expect(Promise.all([first, second])).resolves.toEqual(["current", "current"]);
    expect(fetches).toBe(2);
  });

  test("does not stage a Release Set while launch preparation is validating a candidate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-prepare-single-flight-"));
    temporaryDirectories.push(root);
    let latest = release("electron-runtime-v1-current", 1, 1);
    const seed = new ElectronRuntimeManager({
      root,
      environment: "prod",
      manifestContext,
      fetchManifest: async () => latest,
      installRelease: installFixture,
      validateRelease: async () => undefined
    });
    await seed.prepareForLaunch();
    await seed.completeCandidate();
    latest = release("electron-runtime-v1-candidate", 2, 1);
    await seed.stageLatest();

    let validationCalls = 0;
    let releaseValidation: (() => void) | undefined;
    const validationGate = new Promise<void>(resolve => { releaseValidation = resolve; });
    let manifestFetches = 0;
    const manager = new ElectronRuntimeManager({
      root,
      environment: "prod",
      manifestContext,
      fetchManifest: async () => {
        manifestFetches += 1;
        return latest;
      },
      installRelease: installFixture,
      validateRelease: async () => {
        validationCalls += 1;
        await validationGate;
      }
    });

    const preparing = manager.prepareForLaunch();
    await vi.waitFor(() => expect(validationCalls).toBe(1));
    const focusCheck = manager.stageLatestIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    releaseValidation?.();

    await expect(preparing).resolves.toMatchObject({ releaseId: latest.releaseId, probation: true });
    await expect(focusCheck).resolves.toBe("throttled");
    expect(manifestFetches).toBe(0);
  });

  test("counts a failed Release Set request toward the cooldown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-failed-cooldown-"));
    temporaryDirectories.push(root);
    let nowMillis = Date.parse("2026-08-27T00:00:00Z");
    const current = release("electron-runtime-v1-current", 1, 1);
    let fetches = 0;
    const manager = new ElectronRuntimeManager({
      root,
      environment: "prod",
      manifestContext,
      fetchManifest: async () => {
        fetches += 1;
        if (fetches > 1) throw new Error("offline");
        return current;
      },
      installRelease: installFixture,
      validateRelease: async () => undefined,
      now: () => new Date(nowMillis)
    });

    await manager.prepareForLaunch();
    await manager.completeCandidate();
    nowMillis += AUTOMATIC_UPDATE_CHECK_INTERVAL_MS;
    await expect(manager.stageLatestIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS)).rejects.toThrow("offline");
    nowMillis += 10_000;
    expect(await manager.stageLatestIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS)).toBe("throttled");
    expect(fetches).toBe(2);
  });

  test("counts failures before the Manifest request toward the cooldown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-pre-manifest-failure-"));
    temporaryDirectories.push(root);
    let nowMillis = Date.parse("2026-08-27T00:00:00Z");
    const current = release("electron-runtime-v1-current", 1, 1);
    let fetches = 0;
    const manager = new ElectronRuntimeManager({
      root,
      environment: "prod",
      manifestContext,
      fetchManifest: async () => {
        fetches += 1;
        return current;
      },
      installRelease: installFixture,
      validateRelease: async () => undefined,
      now: () => new Date(nowMillis)
    });

    await manager.prepareForLaunch();
    await manager.completeCandidate();
    const statePath = path.join(root, "state.json");
    const validState = await readFile(statePath, "utf8");
    await writeFile(statePath, "not json");
    nowMillis += AUTOMATIC_UPDATE_CHECK_INTERVAL_MS;

    await expect(manager.stageLatestIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS)).rejects.toThrow();
    nowMillis += 10_000;
    await expect(manager.stageLatestIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS)).resolves.toBe("throttled");
    expect(fetches).toBe(1);
    await writeFile(statePath, validState);
  });

  test("rechecks after the wall clock moves backward", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "electron-runtime-clock-rollback-"));
    temporaryDirectories.push(root);
    let nowMillis = Date.parse("2026-08-27T00:00:00Z");
    const current = release("electron-runtime-v1-current", 1, 1);
    let fetches = 0;
    const manager = new ElectronRuntimeManager({
      root,
      environment: "prod",
      manifestContext,
      fetchManifest: async () => {
        fetches += 1;
        return current;
      },
      installRelease: installFixture,
      validateRelease: async () => undefined,
      now: () => new Date(nowMillis)
    });

    await manager.prepareForLaunch();
    await manager.completeCandidate();
    nowMillis -= 1_000;

    await expect(manager.stageLatestIfStale(AUTOMATIC_UPDATE_CHECK_INTERVAL_MS)).resolves.toBe("current");
    expect(fetches).toBe(2);
  });

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


describe("runtime acquisition recovery", () => {
  test("resumes a failed install after restart without fetching a second manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-acquisition-offline-"));
    temporaryDirectories.push(root);
    const target = release("unused", 2, 3);
    const first = new ElectronRuntimeManager({
      root, environment: "prod", manifestContext,
      fetchManifest: async () => target,
      installRelease: async () => { throw new Error("connection lost after downloads"); },
      validateRelease: async () => undefined
    });
    await expect(first.prepareForLaunch()).rejects.toThrow("connection lost");
    const second = createManager(root, async () => { throw new Error("offline manifest request"); });
    const result = await second.prepareForLaunch();
    expect(result.releaseId).toBe(target.releaseId);
    expect(result.probation).toBe(true);
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8")).badReleases).toEqual([]);
    await second.completeCandidate();
    await expect(access(path.join(root, "acquisition.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not retry a definitively bad acquisition forever", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-acquisition-bad-"));
    temporaryDirectories.push(root);
    const bad = release("unused", 2, 2);
    const next = release("unused", 3, 3);
    const first = new ElectronRuntimeManager({
      root, environment: "prod", manifestContext,
      fetchManifest: async () => bad,
      installRelease: async () => { throw new RuntimeArtifactValidationError("ARTIFACT_DIGEST_MISMATCH", "bad bytes"); },
      validateRelease: async () => undefined
    });
    await expect(first.prepareForLaunch()).rejects.toThrow();
    expect((await createManager(root, async () => next).prepareForLaunch()).releaseId).toBe(next.releaseId);
  });

  test("leaves acquisition downloads referenced while an unrelated candidate completes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-acquisition-retain-"));
    temporaryDirectories.push(root);
    const active = release("unused", 1, 1);
    const candidate = release("unused", 2, 2);
    let next = active;
    const manager = new ElectronRuntimeManager({
      root, environment: "prod", manifestContext,
      fetchManifest: async () => next,
      installRelease: async (manifest, staging) => {
        if (manifest.releaseId === candidate.releaseId) {
          await mkdir(path.join(root, "downloads"), { recursive: true });
          await writeFile(path.join(root, "downloads", `${manifest.artifacts.harness.sha256}.tar.zst.part`), "partial");
          throw new Error("network unavailable");
        }
        await installFixture(manifest, staging);
      },
      validateRelease: async () => undefined
    });
    await manager.prepareForLaunch();
    await manager.completeCandidate();
    next = candidate;
    await expect(manager.stageLatest()).rejects.toThrow("network unavailable");
    // A subsequent bootstrap uses the working active immediately, preserving the resumable update.
    expect((await manager.prepareForLaunch()).releaseId).toBe(active.releaseId);
    expect(await readFile(path.join(root, "downloads", `${candidate.artifacts.harness.sha256}.tar.zst.part`), "utf8")).toBe("partial");
  });
});


describe("cache epoch isolation", () => {
  test("does not launch legacy active or fallback state offline and leaves its files intact", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "runtime-cache-epoch-"));
    temporaryDirectories.push(userData);
    const oldRoot = path.join(userData, "runtime-manager", "electron-v1");
    const legacy = release("unused", 1, 1);
    const old = createManager(oldRoot, async () => legacy);
    await old.prepareForLaunch();
    await old.completeCandidate();
    const oldState = await readFile(path.join(oldRoot, "state.json"), "utf8");
    const { resolveRuntimeCacheRoot, readPreviousRuntimeBaseline } = await import("../src/runtime/cache-epoch.js");
    const newRoot = resolveRuntimeCacheRoot(userData);
    const baseline = await readPreviousRuntimeBaseline(userData, "prod", manifestContext);
    expect(baseline?.releaseId).toBe(legacy.releaseId);
    await expect(createManager(newRoot, async () => { throw new Error("offline"); }).prepareForLaunch()).rejects.toThrow("offline");
    expect(await readFile(path.join(oldRoot, "state.json"), "utf8")).toBe(oldState);
    await expect(access(dshEntry(oldRoot, legacy.releaseId))).resolves.toBeUndefined();
    const fresh = createManager(newRoot, async () => release("unused", 2, 2));
    await fresh.prepareForLaunch();
    await fresh.completeCandidate();
    expect((await createManager(newRoot, async () => { throw new Error("offline"); }).prepareForLaunch()).manifest.artifacts.harness.versionCode).toBe(2);
  });

  test("does not import another environment's previous component baseline", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "runtime-cache-environment-"));
    temporaryDirectories.push(userData);
    const oldRoot = path.join(userData, "runtime-manager", "electron-v1");
    const old = createManager(oldRoot, async () => release("unused", 1, 1));
    await old.prepareForLaunch(); await old.completeCandidate();
    const { readPreviousRuntimeBaseline } = await import("../src/runtime/cache-epoch.js");
    expect(await readPreviousRuntimeBaseline(userData, "test", manifestContext)).toBeUndefined();
  });
});

describe('committed candidate recovery and lazy Code baseline', () => {
  test('committed decision promotes the exact attempted local candidate before bootstrap rollback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-committed-recovery-')); temporaryDirectories.push(root);
    const target = release('unused', 2, 2);
    const first = createManager(root, async () => target);
    await first.prepareForLaunch();
    const resumed = createManager(root, async () => {throw new Error('offline');});
    await resumed.recoverCommittedCandidate(target.releaseId);
    expect((await resumed.prepareForLaunch()).probation).toBe(false);
    await expect(resumed.recoverCommittedCandidate(target.releaseId)).resolves.toBeUndefined();
    await expect(resumed.recoverCommittedCandidate(release('unused',3,3).releaseId)).rejects.toThrow();
  });

  test.each([[1, 2], [3, 1]])('rejects initial Code regression %s/%s before installing', async (harness, plugin) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-initial-baseline-')); temporaryDirectories.push(root);
    let installed = false;
    const manager = new ElectronRuntimeManager({root,environment:'prod',manifestContext,
      readInitialBaseline:async () => release('unused',2,2),
      fetchManifest:async () => release('unused',harness,plugin),
      installRelease:async () => {installed=true;},validateRelease:async()=>undefined});
    await expect(manager.prepareForLaunch()).rejects.toThrow('Code');
    expect(installed).toBe(false);
  });

  test('reads initial baseline only when no usable local release or acquisition exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-lazy-baseline-')); temporaryDirectories.push(root);
    let reads = 0;
    const target=release('unused',2,2);
    const first = new ElectronRuntimeManager({root,environment:'prod',manifestContext,
      readInitialBaseline:async()=>{reads++;return target;},fetchManifest:async baseline=>{expect(baseline?.releaseId).toBe(target.releaseId);return target;},
      installRelease:async()=>{throw new Error('interrupted');},validateRelease:async()=>undefined});
    await expect(first.prepareForLaunch()).rejects.toThrow('interrupted');
    expect(reads).toBe(1);
    const resumed = new ElectronRuntimeManager({root,environment:'prod',manifestContext,
      readInitialBaseline:async()=>{throw new Error('must remain lazy');},fetchManifest:async()=>{throw new Error('offline');},
      installRelease:installFixture,validateRelease:async()=>undefined});
    await resumed.prepareForLaunch(); await resumed.completeCandidate();
    expect((await resumed.prepareForLaunch()).probation).toBe(false);
  });
});

test.each(['interrupted','manual'] as const)('retries a complete fresh-epoch %s candidate offline without a fallback', async mode => {
 const root=await mkdtemp(path.join(os.tmpdir(),'runtime-offline-trial-'));temporaryDirectories.push(root);
 const target=release('unused',2,2);const first=createManager(root,async()=>target);
 await first.prepareForLaunch();
 if(mode==='manual') await first.rollbackCandidate({phase:'harness-start',scope:'unknown',code:'START_FAILED',reason:'local startup failed'});
 const next=createManager(root,async()=>{throw new Error('must not fetch');});
 const recovered=await next.prepareForLaunch();
 expect(recovered.releaseId).toBe(target.releaseId);expect(recovered.probation).toBe(true);
});

describe('manual recovery from a failed acquisition', () => {
  async function failedAcquisition(code = 'RUNTIME_START_FAILED', reason = 'local startup failed') {
    const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-failed-acquisition-'));
    temporaryDirectories.push(root);
    const old = release('old', 2, 2);
    const first = createManager(root, async () => old);
    await first.prepareForLaunch();
    await first.rollbackCandidate({ phase: 'harness-start', scope: 'unknown', code, reason });
    return {root, old};
  }

  test('manual retry refreshes the failed pair with its Code baseline and preserves downloaded Harness bytes', async () => {
    const {root, old} = await failedAcquisition();
    const next = release('new', 2, 3);
    const cached = path.join(root, 'downloads', `${old.artifacts.harness.sha256}.tar.zst`);
    await writeFile(cached, 'cached Harness');
    const fetch = vi.fn(async () => next);
    const manager = createManager(root, fetch);
    const [a, b] = await Promise.all([
      manager.prepareForLaunch(undefined, {manualRetry: true}),
      manager.prepareForLaunch(undefined, {manualRetry: true})
    ]);
    expect(a.releaseId).toBe(next.releaseId);
    expect(b.releaseId).toBe(next.releaseId);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(old);
    expect(await readFile(cached, 'utf8')).toBe('cached Harness');
    expect(JSON.parse(await readFile(path.join(root, 'acquisition.json'), 'utf8')).manifest.releaseId).toBe(next.releaseId);
  });

  test('offline manual retry retains the old acquisition, files and failure record', async () => {
    const {root} = await failedAcquisition();
    const before = await readFile(path.join(root, 'acquisition.json'), 'utf8');
    const state = await readFile(path.join(root, 'state.json'), 'utf8');
    const manager = createManager(root, async () => {throw new Error('offline');});
    await expect(manager.prepareForLaunch(undefined, {manualRetry: true})).rejects.toThrow('offline');
    expect(await readFile(path.join(root, 'acquisition.json'), 'utf8')).toBe(before);
    expect(await readFile(path.join(root, 'state.json'), 'utf8')).toBe(state);
  });

  test('rejects a component Code regression without replacing the acquisition', async () => {
    const {root} = await failedAcquisition();
    const before = await readFile(path.join(root, 'acquisition.json'), 'utf8');
    const manager = createManager(root, async () => release('regressed', 1, 3));
    await expect(manager.prepareForLaunch(undefined, {manualRetry: true})).rejects.toThrow('Code');
    expect(await readFile(path.join(root, 'acquisition.json'), 'utf8')).toBe(before);
  });

  test.each(['PLUGIN_DESKTOP_READINESS_UNSUPPORTED', 'RUNTIME_START_FAILED'])('does not relaunch the same incompatible pair (%s)', async code => {
    const reason = 'Required plugin does not support desktop Harness readiness v1';
    const {root, old} = await failedAcquisition(code, reason);
    const installed: string[] = [];
    const fetch = vi.fn(async () => old);
    const manager = createManager(root, fetch, installed);
    await expect(manager.prepareForLaunch(undefined, {manualRetry: true})).rejects.toThrow(reason);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(old);
    expect(installed).toEqual([]);
    expect(JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).candidateReleaseId).toBeUndefined();
  });

  test('background checks with no active release skip without fetching or claiming current', async () => {
    const {root} = await failedAcquisition();
    const fetch = vi.fn(async () => release('new', 2, 3));
    await expect(createManager(root, fetch).stageLatest()).resolves.toBe('no-active');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('manual retry still resumes an unfinished install locally without refreshing the manifest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-partial-manual-'));
    temporaryDirectories.push(root);
    const old = release('old', 2, 2);
    const first = new ElectronRuntimeManager({root, environment: 'prod', manifestContext,
      fetchManifest: async () => old, installRelease: async () => {throw new Error('download interrupted');},
      validateRelease: async () => undefined});
    await expect(first.prepareForLaunch()).rejects.toThrow('download interrupted');
    const fetch = vi.fn(async () => {throw new Error('must stay offline');});
    await expect(createManager(root, fetch).prepareForLaunch(undefined, {manualRetry: true})).resolves.toMatchObject({releaseId: old.releaseId});
    expect(fetch).not.toHaveBeenCalled();
  });
});
