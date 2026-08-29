import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isDeterministicRuntimeArtifactError,
  RuntimeArtifactValidationError,
  runtimeArtifactFailureCode,
  runtimeFailureScope
} from "./errors.js";
import {
  compareElectronRuntimeCandidate,
  parseElectronRuntimeManifest,
  type ElectronRuntimeContext,
  type ElectronRuntimeManifest
} from "./manifest.js";
import {
  beginRuntimeCandidate,
  completeRuntimeCandidate,
  createEmptyRuntimeState,
  markRuntimeCandidateAttempted,
  parseRuntimeInstallState,
  quarantineRuntimeRelease,
  recordRuntimeLaunchFailure,
  rollbackRuntimeCandidate,
  type RuntimeFailurePhase,
  type RuntimeFailureScope,
  type RuntimeInstallState
} from "./state.js";
import type { RuntimeEnvironment } from "./service-config.js";
import { validateInstalledElectronRuntime } from "./installer.js";

export interface ResolvedElectronRuntime {
  releaseId: string;
  releasePath: string;
  manifest: ElectronRuntimeManifest;
  probation: boolean;
  dshBinPath: string;
  pluginPath: string;
  packageManagerBinPath: string;
  packageManagerCliPath: string;
}

export interface RuntimeInstallProgress {
  kind: "runtime-installing";
  phase: "download" | "verify" | "install";
  harnessPercent: number;
  pluginPercent: number;
}

export interface RuntimeCandidateFailure {
  phase: RuntimeFailurePhase;
  scope: RuntimeFailureScope;
  code: string;
  reason: string;
}

export class BadRuntimeReleaseBlockedError extends Error {
  readonly displayTitle = "当前运行环境无法使用";
  readonly suggestion = "重新加载只会下载当前环境的运行组件，不会删除项目、设置、市集插件或其他用户数据。";
  readonly technicalDetails: string;
  readonly showWorkspaceAction = false;
  readonly showReloadRuntimeAction = true;

  constructor(
    readonly releaseId: string,
    readonly environment: RuntimeEnvironment,
    reason: string
  ) {
    super("检测到当前运行组件校验失败，Arkme 无法继续启动。");
    this.name = "BadRuntimeReleaseBlockedError";
    this.technicalDetails = `${environment === "test" ? "测试" : "生产"}环境 · ${releaseId} · ${reason}`;
  }
}

interface RuntimeManagerDependencies {
  fetchManifest: () => Promise<ElectronRuntimeManifest>;
  installRelease: (
    manifest: ElectronRuntimeManifest,
    stagingPath: string,
    progress?: (state: RuntimeInstallProgress) => void
  ) => Promise<void>;
  now?: () => Date;
  validateRelease?: (manifest: ElectronRuntimeManifest, releasePath: string) => Promise<void>;
}

interface RuntimeManagerOptions extends RuntimeManagerDependencies {
  root: string;
  environment: RuntimeEnvironment;
  manifestContext: ElectronRuntimeContext;
}

const RELEASE_ENVIRONMENT_RECEIPT = "runtime-environment.json";

export class ElectronRuntimeManager {
  private readonly statePath: string;
  private readonly releasesPath: string;
  private readonly stagingPath: string;
  private readonly downloadsPath: string;
  private readonly now: () => Date;
  private readonly validateRelease: (manifest: ElectronRuntimeManifest, releasePath: string) => Promise<void>;
  private readonly legacyUnmarkedReleaseIds = new Set<string>();
  private discardExistingRuntime = false;
  private stateNeedsPersistence = false;

  constructor(private readonly options: RuntimeManagerOptions) {
    this.statePath = path.join(options.root, "state.json");
    this.releasesPath = path.join(options.root, "releases");
    this.stagingPath = path.join(options.root, "staging");
    this.downloadsPath = path.join(options.root, "downloads");
    this.now = options.now ?? (() => new Date());
    this.validateRelease = options.validateRelease ?? validateInstalledElectronRuntime;
  }

  async prepareForLaunch(
    progress?: (state: RuntimeInstallProgress) => void
  ): Promise<ResolvedElectronRuntime> {
    await this.ensureDirectories();
    const state = await this.readState();
    await this.persistMigratedStateIfNeeded(state);
    if (state.candidateReleaseId !== undefined) {
      const candidateId = state.candidateReleaseId;
      if (state.candidateAttemptedAt !== undefined) {
        try {
          await this.resolveRelease(candidateId, false);
          rollbackRuntimeCandidate(state, {
            phase: "harness-start",
            scope: "unknown",
            code: "CANDIDATE_START_INTERRUPTED",
            reason: "The previous candidate launch ended before validation completed",
            occurredAt: this.now().toISOString()
          });
          await this.writeState(state);
        } catch (error) {
          const quarantined = await this.handleCandidateValidationFailure(state, candidateId, error);
          if (!quarantined && state.activeReleaseId === undefined) throw error;
        }
      } else {
        try {
          const candidate = await this.resolveRelease(candidateId, true);
          markRuntimeCandidateAttempted(state, this.now().toISOString());
          await this.writeState(state);
          return candidate;
        } catch (error) {
          const quarantined = await this.handleCandidateValidationFailure(state, candidateId, error);
          if (!quarantined && state.activeReleaseId === undefined) throw error;
        }
      }
    }
    const active = await this.resolveActiveReleaseOrRecover(state);
    if (active !== undefined) return active;

    const manifest = await this.options.fetchManifest();
    const bad = state.badReleases.find(item => item.releaseId === manifest.releaseId);
    if (bad !== undefined) {
      throw new BadRuntimeReleaseBlockedError(manifest.releaseId, this.options.environment, bad.reason);
    }
    try {
      await this.install(manifest, progress);
    } catch (error) {
      if (isDeterministicRuntimeArtifactError(error)) {
        this.quarantineStateRelease(state, manifest.releaseId, error);
        await this.writeState(state);
        await rm(path.join(this.releasesPath, manifest.releaseId), { recursive: true, force: true }).catch(() => undefined);
        throw this.badReleaseError(manifest.releaseId, errorMessage(error));
      }
      recordRuntimeLaunchFailure(state, manifest.releaseId, {
        phase: "install",
        scope: runtimeFailureScope(error),
        code: systemErrorCode(error) ?? "RUNTIME_INSTALL_FAILED",
        reason: errorMessage(error),
        occurredAt: this.now().toISOString()
      });
      await this.writeState(state);
      throw error;
    }
    beginRuntimeCandidate(state, manifest.releaseId);
    markRuntimeCandidateAttempted(state, this.now().toISOString());
    await this.writeState(state);
    try {
      return await this.resolveRelease(manifest.releaseId, true);
    } catch (error) {
      const quarantined = await this.handleCandidateValidationFailure(state, manifest.releaseId, error);
      if (quarantined) throw this.badReleaseError(manifest.releaseId, errorMessage(error));
      throw error;
    }
  }

  async stageLatest(
    progress?: (state: RuntimeInstallProgress) => void
  ): Promise<"current" | "stale" | "bad" | "deferred" | "staged"> {
    await this.ensureDirectories();
    const state = await this.readState();
    await this.persistMigratedStateIfNeeded(state);
    if (state.activeReleaseId === undefined) return "current";
    let baseline = await this.resolveRelease(state.activeReleaseId, false);
    if (state.candidateReleaseId !== undefined) {
      try {
        baseline = await this.resolveRelease(state.candidateReleaseId, true);
      } catch (error) {
        const candidateId = state.candidateReleaseId;
        await this.handleCandidateValidationFailure(state, candidateId, error);
      }
    }
    const candidate = await this.options.fetchManifest();
    const decision = compareElectronRuntimeCandidate(baseline.manifest, candidate);
    if (decision === "current" && state.candidateReleaseId === candidate.releaseId) return "staged";
    if (decision !== "newer") return decision;
    if (state.badReleases.some(item => item.releaseId === candidate.releaseId)) return "bad";
    if (state.deferredReleases.some(item => item.releaseId === candidate.releaseId)) return "deferred";
    if (state.candidateReleaseId === candidate.releaseId) return "staged";
    await this.install(candidate, progress);
    beginRuntimeCandidate(state, candidate.releaseId);
    await this.writeState(state);
    return "staged";
  }

  async completeCandidate(): Promise<void> {
    const state = await this.readState();
    completeRuntimeCandidate(state);
    await this.writeState(state);
    await this.pruneUnreferencedRuntimeData(state).catch(() => undefined);
  }

  async rollbackCandidate(
    failure: RuntimeCandidateFailure
  ): Promise<ResolvedElectronRuntime | undefined> {
    const state = await this.readState();
    rollbackRuntimeCandidate(state, {
      ...failure,
      occurredAt: this.now().toISOString()
    });
    await this.writeState(state);
    await this.pruneUnreferencedRuntimeData(state).catch(() => undefined);
    return state.activeReleaseId === undefined
      ? undefined
      : await this.resolveRelease(state.activeReleaseId, false);
  }

  async quarantineCandidate(
    failure: { code: string; reason: string }
  ): Promise<ResolvedElectronRuntime | undefined> {
    const state = await this.readState();
    const releaseId = state.candidateReleaseId;
    if (releaseId === undefined) throw new Error("No Electron runtime candidate is awaiting validation");
    quarantineRuntimeRelease(state, releaseId, {
      ...failure,
      failedAt: this.now().toISOString()
    });
    await this.writeState(state);
    await rm(path.join(this.releasesPath, releaseId), { recursive: true, force: true }).catch(() => undefined);
    await this.pruneUnreferencedRuntimeData(state).catch(() => undefined);
    return state.activeReleaseId === undefined
      ? undefined
      : await this.resolveRelease(state.activeReleaseId, false);
  }

  async reloadCurrentEnvironment(
    progress?: (state: RuntimeInstallProgress) => void
  ): Promise<ResolvedElectronRuntime> {
    await this.ensureDirectories();
    const state = await this.readState();
    await this.persistMigratedStateIfNeeded(state);
    if (state.activeReleaseId !== undefined) {
      throw new Error("The current environment is already using a verified runtime release");
    }
    if (state.candidateReleaseId !== undefined) {
      throw new Error("A runtime candidate is already awaiting validation");
    }
    if (state.badReleases.length === 0) {
      throw new Error("The current environment is not blocked by a Bad Release");
    }
    const manifest = await this.options.fetchManifest();
    await Promise.all([
      rm(path.join(this.downloadsPath, `${manifest.artifacts.harness.sha256}.tar.zst`), { force: true }),
      rm(path.join(this.downloadsPath, `${manifest.artifacts.requiredPlugin.sha256}.tar.zst`), { force: true })
    ]);
    this.discardExistingRuntime = true;
    try {
      await this.install(manifest, progress);
    } catch (error) {
      throw this.badReleaseError(
        manifest.releaseId,
        `重新加载失败：${errorMessage(error)}`
      );
    }
    beginRuntimeCandidate(state, manifest.releaseId);
    markRuntimeCandidateAttempted(state, this.now().toISOString());
    await this.writeState(state);
    return await this.resolveRelease(manifest.releaseId, true);
  }

  private async install(
    manifest: ElectronRuntimeManifest,
    progress?: (state: RuntimeInstallProgress) => void
  ): Promise<void> {
    const releasePath = path.join(this.releasesPath, manifest.releaseId);
    if (!this.discardExistingRuntime) {
      try {
        await this.resolveRelease(manifest.releaseId, false);
        return;
      } catch {
        // A complete same-environment release is reusable; every other shape is replaced through staging.
      }
    }
    const stagingPath = path.join(this.stagingPath, `${manifest.releaseId}-${randomUUID()}`);
    await rm(stagingPath, { recursive: true, force: true });
    await mkdir(stagingPath, { recursive: true });
    try {
      await this.options.installRelease(manifest, stagingPath, progress);
      await writeFile(
        path.join(stagingPath, RELEASE_ENVIRONMENT_RECEIPT),
        `${JSON.stringify({ schemaVersion: 1, environment: this.options.environment }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 }
      );
      await writeFile(path.join(stagingPath, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      await rm(releasePath, { recursive: true, force: true });
      await rename(stagingPath, releasePath);
      this.discardExistingRuntime = false;
      await this.resolveRelease(manifest.releaseId, false);
    } finally {
      await rm(stagingPath, { recursive: true, force: true });
    }
  }

  private async resolveRelease(releaseId: string, probation: boolean): Promise<ResolvedElectronRuntime> {
    const releasePath = path.join(this.releasesPath, releaseId);
    let document: unknown;
    try {
      document = JSON.parse(await readFile(path.join(releasePath, "release.json"), "utf8")) as unknown;
    } catch (error) {
      if (isMissingFile(error)) {
        throw new RuntimeArtifactValidationError(
          "REQUIRED_FILE_MISSING",
          "Electron runtime stored release manifest is missing",
          "verify",
          { cause: error }
        );
      }
      if (!(error instanceof SyntaxError)) throw error;
      throw new RuntimeArtifactValidationError("RELEASE_MANIFEST_INVALID", "Electron runtime stored release manifest is invalid", "verify", { cause: error });
    }
    const manifest = parseElectronRuntimeManifest(document, this.options.manifestContext);
    if (manifest.releaseId !== releaseId) {
      throw new RuntimeArtifactValidationError("RELEASE_IDENTITY_MISMATCH", "Electron runtime release identity mismatch");
    }
    await this.assertReleaseEnvironment(releaseId, releasePath);
    const dshBinPath = path.join(releasePath, manifest.artifacts.harness.entry);
    const pluginPath = path.join(releasePath, manifest.artifacts.requiredPlugin.target);
    const packageManagerBinPath = path.join(releasePath, "harness", "node_modules", ".bin");
    const packageManagerCliPath = path.join(releasePath, "harness", "node_modules", "pnpm", "bin", "pnpm.cjs");
    try {
      await Promise.all([
        access(dshBinPath),
        access(path.join(pluginPath, "package.json")),
        access(path.join(pluginPath, "lib", "index.js")),
        access(packageManagerCliPath)
      ]);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      throw new RuntimeArtifactValidationError(
        "REQUIRED_FILE_MISSING",
        `Electron runtime release ${releaseId} is missing a required file`,
        "verify",
        { cause: error }
      );
    }
    await this.validateRelease(manifest, releasePath);
    return { releaseId, releasePath, manifest, probation, dshBinPath, pluginPath, packageManagerBinPath, packageManagerCliPath };
  }

  private async assertReleaseEnvironment(releaseId: string, releasePath: string): Promise<void> {
    const receiptPath = path.join(releasePath, RELEASE_ENVIRONMENT_RECEIPT);
    try {
      let receipt: {
        schemaVersion?: unknown;
        environment?: unknown;
      };
      try {
        receipt = JSON.parse(await readFile(receiptPath, "utf8")) as typeof receipt;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new RuntimeArtifactValidationError("ENVIRONMENT_RECEIPT_INVALID", `Electron runtime release environment receipt is invalid for ${releaseId}`, "verify", { cause: error });
      }
      if (receipt.schemaVersion !== 1 || receipt.environment !== this.options.environment) {
        throw new RuntimeArtifactValidationError("ENVIRONMENT_MISMATCH", `Electron runtime release environment mismatch for ${releaseId}`);
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      if (!this.legacyUnmarkedReleaseIds.has(releaseId)) {
        throw new RuntimeArtifactValidationError(
          "ENVIRONMENT_RECEIPT_MISSING",
          `Electron runtime release environment receipt is missing for ${releaseId}`,
          "verify",
          { cause: error }
        );
      }
      await writeFile(
        receiptPath,
        `${JSON.stringify({ schemaVersion: 1, environment: this.options.environment }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 }
      );
      this.legacyUnmarkedReleaseIds.delete(releaseId);
    }
  }

  private async resolveActiveReleaseOrRecover(
    state: RuntimeInstallState
  ): Promise<ResolvedElectronRuntime | undefined> {
    const activeId = state.activeReleaseId;
    if (activeId === undefined) return undefined;
    try {
      return await this.resolveRelease(activeId, false);
    } catch (error) {
      const occurredAt = this.now().toISOString();
      recordRuntimeLaunchFailure(state, activeId, {
        phase: "verify",
        scope: runtimeFailureScope(error),
        code: systemErrorCode(error) ?? "ACTIVE_RELEASE_UNAVAILABLE",
        reason: errorMessage(error),
        occurredAt
      });
      if (!isDeterministicRuntimeArtifactError(error)) {
        await this.writeState(state);
        throw error;
      }
      const fallbackId = state.previousReleaseId;
      if (fallbackId !== undefined && fallbackId !== activeId) {
        try {
          const fallback = await this.resolveRelease(fallbackId, false);
          state.activeReleaseId = fallbackId;
          delete state.previousReleaseId;
          await this.writeState(state);
          await rm(path.join(this.releasesPath, activeId), { recursive: true, force: true }).catch(() => undefined);
          return fallback;
        } catch (fallbackError) {
          recordRuntimeLaunchFailure(state, fallbackId, {
            phase: "verify",
            scope: runtimeFailureScope(fallbackError),
            code: systemErrorCode(fallbackError) ?? "FALLBACK_RELEASE_UNAVAILABLE",
            reason: errorMessage(fallbackError),
            occurredAt
          });
          if (!isDeterministicRuntimeArtifactError(fallbackError)) {
            await this.writeState(state);
            throw fallbackError;
          }
          delete state.activeReleaseId;
          delete state.previousReleaseId;
          await this.writeState(state);
          await Promise.all([
            rm(path.join(this.releasesPath, activeId), { recursive: true, force: true }).catch(() => undefined),
            rm(path.join(this.releasesPath, fallbackId), { recursive: true, force: true }).catch(() => undefined)
          ]);
          return undefined;
        }
      }
      delete state.activeReleaseId;
      delete state.previousReleaseId;
      await this.writeState(state);
      await rm(path.join(this.releasesPath, activeId), { recursive: true, force: true }).catch(() => undefined);
      return undefined;
    }
  }

  private async handleCandidateValidationFailure(
    state: RuntimeInstallState,
    releaseId: string,
    error: unknown
  ): Promise<boolean> {
    if (isDeterministicRuntimeArtifactError(error)) {
      this.quarantineStateRelease(state, releaseId, error);
      await this.writeState(state);
      await rm(path.join(this.releasesPath, releaseId), { recursive: true, force: true }).catch(() => undefined);
      return true;
    }
    rollbackRuntimeCandidate(state, {
      phase: "verify",
      scope: runtimeFailureScope(error),
      code: systemErrorCode(error) ?? "RELEASE_VALIDATION_RETRYABLE",
      reason: errorMessage(error),
      occurredAt: this.now().toISOString()
    });
    await this.writeState(state);
    return false;
  }

  private quarantineStateRelease(
    state: RuntimeInstallState,
    releaseId: string,
    error: unknown
  ): void {
    quarantineRuntimeRelease(state, releaseId, {
      code: runtimeArtifactFailureCode(error),
      reason: errorMessage(error),
      failedAt: this.now().toISOString()
    });
  }

  private badReleaseError(releaseId: string, reason: string): BadRuntimeReleaseBlockedError {
    return new BadRuntimeReleaseBlockedError(releaseId, this.options.environment, reason);
  }

  private async pruneUnreferencedRuntimeData(state: RuntimeInstallState): Promise<void> {
    const referencedReleaseIds = new Set([
      state.activeReleaseId,
      state.previousReleaseId,
      state.candidateReleaseId,
      ...state.deferredReleases.map(item => item.releaseId)
    ].filter((releaseId): releaseId is string => releaseId !== undefined));
    const referencedDownloads = new Set<string>();
    for (const releaseId of referencedReleaseIds) {
      try {
        const manifest = parseElectronRuntimeManifest(
          JSON.parse(await readFile(path.join(this.releasesPath, releaseId, "release.json"), "utf8")) as unknown,
          this.options.manifestContext
        );
        referencedDownloads.add(`${manifest.artifacts.harness.sha256}.tar.zst`);
        referencedDownloads.add(`${manifest.artifacts.requiredPlugin.sha256}.tar.zst`);
      } catch {
        // A retained deferred release may already have been removed by local cleanup.
      }
    }
    await Promise.all((await readdir(this.releasesPath, { withFileTypes: true }))
      .filter(entry => !referencedReleaseIds.has(entry.name))
      .map(entry => rm(path.join(this.releasesPath, entry.name), { recursive: true, force: true })));
    await mkdir(this.downloadsPath, { recursive: true });
    await Promise.all((await readdir(this.downloadsPath, { withFileTypes: true }))
      .filter(entry => !referencedDownloads.has(entry.name))
      .map(entry => rm(path.join(this.downloadsPath, entry.name), { recursive: true, force: true })));
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.options.root, { recursive: true });
    await Promise.all([
      mkdir(this.releasesPath, { recursive: true }),
      rm(this.stagingPath, { recursive: true, force: true })
    ]);
    await mkdir(this.stagingPath, { recursive: true });
  }

  private async readState(): Promise<RuntimeInstallState> {
    try {
      const document = JSON.parse(await readFile(this.statePath, "utf8")) as Record<string, unknown>;
      if (document.schemaVersion === 1) {
        for (const key of ["activeReleaseId", "previousReleaseId", "pendingReleaseId", "probationReleaseId"]) {
          if (typeof document[key] === "string") this.legacyUnmarkedReleaseIds.add(document[key]);
        }
        this.stateNeedsPersistence = true;
      }
      try {
        return parseRuntimeInstallState(document, this.options.environment);
      } catch (error) {
        if (!/environment mismatch/i.test(errorMessage(error))) throw error;
        this.discardExistingRuntime = true;
        this.stateNeedsPersistence = true;
        return createEmptyRuntimeState(this.options.environment);
      }
    } catch (error) {
      if (isMissingFile(error)) return createEmptyRuntimeState(this.options.environment);
      throw error;
    }
  }

  private async writeState(state: RuntimeInstallState): Promise<void> {
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.statePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async persistMigratedStateIfNeeded(state: RuntimeInstallState): Promise<void> {
    if (!this.stateNeedsPersistence) return;
    await this.writeState(state);
    this.stateNeedsPersistence = false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function systemErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
