import { MAX_APP_VERSION_CODE } from "./app-version-code.js";
import { resolveAppUpdateMetadata, type AppUpdaterUpdateInfo } from "./app-update-metadata.js";
export type { AppUpdaterUpdateInfo } from "./app-update-metadata.js";

type UpdatePlatform = "darwin" | "win32" | "linux";
type UpdateArch = "arm64" | "x64";

export interface SupportedAppUpdateTarget {
  platform: UpdatePlatform;
  arch: UpdateArch;
}

export type ArkmeAppUpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "failed";

export type ArkmeAppUpdateFailureStage = "check" | "download" | "install";

export interface ArkmeAppUpdateSnapshot {
  status: ArkmeAppUpdateStatus;
  currentVersion: string;
  currentVersionCode: number;
  canAutoInstall: boolean;
  checkedAtMillis?: number;
  noUpdateAvailable?: boolean;
  latestVersion?: string;
  latestVersionCode?: number;
  releaseNotes?: string;
  failureStage?: ArkmeAppUpdateFailureStage;
  error?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  downloadedFilePath?: string;
  installWarning?: string;
}

export interface AppUpdaterProgress {
  transferred: number;
  total: number;
}

export interface AppUpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: AppUpdaterUpdateInfo } | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "download-progress", listener: (progress: AppUpdaterProgress) => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "download-progress", listener: (progress: AppUpdaterProgress) => void): this;
}

export interface PendingAppUpdateInstall {
  version: string;
  versionCode: number;
}

type ArkmeAppUpdateControllerOptions = {
  currentVersion: string;
  currentVersionCode: number;
  serviceBaseUrl: string;
  platform: UpdatePlatform;
  arch: UpdateArch;
  fetchImpl?: typeof fetch;
  createUpdater?: (feedURL: string, targetVersion: string) => AppUpdaterPort;
  installUpdate?: (
    target: PendingAppUpdateInstall,
    launchInstaller: () => void,
  ) => Promise<void>;
  previousInstallFailure?: PendingAppUpdateInstall;
  now?: () => number;
};

interface AppUpdateRelease {
  version: string;
  versionCode: number;
  releaseNotes?: string;
  updateFeedURL?: string;
}

function origin(raw: string): string {
  const value = new URL(raw);
  if (value.protocol !== "https:" || value.username || value.password || value.pathname !== "/" || value.search || value.hash) {
    throw new Error("Arkme app update service base URL must be an HTTPS origin");
  }
  return value.origin;
}

function secureURL(raw: string, label: string): URL {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error(`${label}无效`);
  }
  if (value.protocol !== "https:" || value.username || value.password) {
    throw new Error(`${label}必须使用 HTTPS`);
  }
  return value;
}

function updateFeedDirectory(raw: string): string {
  const value = secureURL(raw, "自动更新目录");
  if (!value.pathname.endsWith("/") || value.search || value.hash) {
    throw new Error("自动更新目录格式无效");
  }
  return value.href;
}

export function resolveSupportedAppUpdateTarget(platform: string, arch: string): SupportedAppUpdateTarget | null {
  return (platform === "darwin" && arch === "arm64")
    || (platform === "win32" && arch === "x64")
    || (platform === "linux" && arch === "x64")
    ? { platform, arch }
    : null;
}

export function appUpdateFeedURL(base: string, platform: UpdatePlatform, arch: UpdateArch): string {
  if (!resolveSupportedAppUpdateTarget(platform, arch)) {
    throw new Error(`unsupported Arkme app update target: ${platform}/${arch}`);
  }
  return `${origin(base)}/api/public/v1/arkme/app-update/${platform}/${arch}/latest`;
}

export class ArkmeAppUpdateController {
  private currentSnapshot!: ArkmeAppUpdateSnapshot;
  private readonly listeners = new Set<(snapshot: ArkmeAppUpdateSnapshot) => void>();
  private updaterError: Error | undefined;
  private detachUpdaterError: (() => void) | undefined;

  private get snapshot(): ArkmeAppUpdateSnapshot { return this.currentSnapshot; }
  private set snapshot(value: ArkmeAppUpdateSnapshot) {
    this.currentSnapshot = value;
    for (const listener of this.listeners) listener({ ...value });
  }

  subscribe(listener: (snapshot: ArkmeAppUpdateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private readonly feedURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private release: AppUpdateRelease | undefined;
  private updater: AppUpdaterPort | undefined;
  private checkInFlight: Promise<ArkmeAppUpdateSnapshot> | undefined;
  private downloadInFlight: Promise<ArkmeAppUpdateSnapshot> | undefined;
  private installInFlight: Promise<ArkmeAppUpdateSnapshot> | undefined;
  private lastCheckStartedAtMillis?: number;

  constructor(private readonly options: ArkmeAppUpdateControllerOptions) {
    if (!Number.isSafeInteger(options.currentVersionCode) || options.currentVersionCode <= 0 || options.currentVersionCode > MAX_APP_VERSION_CODE) {
      throw new Error("Current application Version Code must be a positive integer");
    }
    this.snapshot = options.previousInstallFailure === undefined
      ? {
          status: "idle",
          currentVersion: options.currentVersion,
          currentVersionCode: options.currentVersionCode,
          canAutoInstall: false,
        }
      : {
          status: "failed",
          currentVersion: options.currentVersion,
          currentVersionCode: options.currentVersionCode,
          canAutoInstall: false,
          latestVersion: options.previousInstallFailure.version,
          latestVersionCode: options.previousInstallFailure.versionCode,
          failureStage: "install",
          error: "上次安装未完成，请重新尝试",
        };
    this.feedURL = appUpdateFeedURL(options.serviceBaseUrl, options.platform, options.arch);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    if (options.previousInstallFailure !== undefined) this.lastCheckStartedAtMillis = this.now();
  }

  snapshotNow(): ArkmeAppUpdateSnapshot {
    return { ...this.snapshot };
  }

  async prepareNow(): Promise<ArkmeAppUpdateSnapshot> {
    return this.prepareCheckedUpdate(await this.checkNow());
  }

  async prepareIfStale(minimumIntervalMs: number): Promise<ArkmeAppUpdateSnapshot> {
    return this.prepareCheckedUpdate(await this.checkIfStale(minimumIntervalMs));
  }

  private prepareCheckedUpdate(state: ArkmeAppUpdateSnapshot): Promise<ArkmeAppUpdateSnapshot> {
    // downloadUpdate validates its persisted cache before transferring a package.
    // Keep native autoDownload disabled until our Version Code/metadata gate passes.
    return state.status === "available" && state.canAutoInstall
      ? this.download()
      : Promise.resolve(state);
  }

  checkNow(): Promise<ArkmeAppUpdateSnapshot> {
    if (this.isUpdateStateActive()) return Promise.resolve(this.snapshotNow());
    return this.startCheck();
  }

  checkIfStale(minimumIntervalMs: number): Promise<ArkmeAppUpdateSnapshot> {
    if (this.checkInFlight !== undefined) return this.checkInFlight;
    if (this.isUpdateStateActive()) return Promise.resolve(this.snapshotNow());
    if (this.lastCheckStartedAtMillis !== undefined) {
      const elapsedMillis = this.now() - this.lastCheckStartedAtMillis;
      if (elapsedMillis >= 0 && elapsedMillis < minimumIntervalMs) return Promise.resolve(this.snapshotNow());
    }
    return this.startCheck();
  }

  private startCheck(): Promise<ArkmeAppUpdateSnapshot> {
    if (this.checkInFlight !== undefined) return this.checkInFlight;
    this.lastCheckStartedAtMillis = this.now();
    const task = this.performCheck();
    this.checkInFlight = task;
    const clear = () => {
      if (this.checkInFlight === task) this.checkInFlight = undefined;
    };
    void task.then(clear, clear);
    return task;
  }

  private async performCheck(): Promise<ArkmeAppUpdateSnapshot> {
    const { error: _error, failureStage: _failureStage, ...checkingSnapshot } = this.snapshot;
    this.snapshot = { ...checkingSnapshot, status: "checking" };
    let discoveredRelease: AppUpdateRelease | undefined;
    let candidateUpdater: AppUpdaterPort | undefined;
    let detachCandidateError: (() => void) | undefined;
    try {
      const response = await this.fetchImpl(this.feedURL, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (this.isUpdateStateActive()) return this.snapshotNow();
      if (response.status === 404) return this.setCurrent();
      if (!response.ok) throw new Error(`更新服务返回 HTTP ${response.status}`);
      const body = await response.json() as {
        version?: unknown;
        versionCode?: unknown;
        releaseNotes?: unknown;
        updateFeedUrl?: unknown;
      };
      if (typeof body.version !== "string" || body.version.trim() === "") {
        throw new Error("更新服务返回格式无效");
      }
      if (!Number.isSafeInteger(body.versionCode) || (body.versionCode as number) < 0 || (body.versionCode as number) > MAX_APP_VERSION_CODE) {
        throw new Error("更新服务返回的 Version Code 无效");
      }
      if (this.isUpdateStateActive()) return this.snapshotNow();
      if ((body.versionCode as number) <= this.options.currentVersionCode) return this.setCurrent();

      // Discovery is valid even if the automatic installer metadata is not.
      // Retain the target so the notice can offer the official website on failure.
      discoveredRelease = {
        version: body.version,
        versionCode: body.versionCode as number,
        ...(typeof body.releaseNotes === "string" ? { releaseNotes: body.releaseNotes } : {}),
      };

      if (body.updateFeedUrl != null && typeof body.updateFeedUrl !== "string") {
        throw new Error("自动更新目录格式无效");
      }
      const updateFeedURL = typeof body.updateFeedUrl === "string" && body.updateFeedUrl.trim() !== ""
        ? body.updateFeedUrl
        : undefined;

      const release: AppUpdateRelease = {
        ...discoveredRelease,
        ...(updateFeedURL !== undefined
          ? { updateFeedURL: updateFeedDirectory(updateFeedURL) }
          : {}),
      };
      let canAutoInstall = false;
      if (release.updateFeedURL !== undefined && this.options.platform !== "linux" && this.options.createUpdater !== undefined) {
        const updater = this.options.createUpdater(release.updateFeedURL, release.version);
        candidateUpdater = updater;
        let candidateError: Error | undefined;
        const onError = (error: Error) => {
          candidateError = error;
          if (this.updater !== updater) return;
          this.updaterError = error;
          const stage = this.snapshot.status === "failed" ? this.snapshot.failureStage ?? "check"
            : this.snapshot.status === "installing" ? "install"
            : this.snapshot.status === "downloading" || this.snapshot.status === "downloaded" ? "download" : "check";
          this.fail(stage, error.message);
        };
        updater.on("error", onError);
        detachCandidateError = () => { updater.removeListener("error", onError); };
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        // This flag is deliberately enabled only after the Version Code gate above.
        updater.allowDowngrade = true;
        const result = await updater.checkForUpdates();
        if (candidateError !== undefined) throw candidateError;
        if (result === null || !result.isUpdateAvailable) throw new Error("自动更新元数据未返回可安装版本");
        resolveAppUpdateMetadata(result.updateInfo, {
          version: release.version,
          versionCode: release.versionCode,
          feedURL: release.updateFeedURL,
          platform: this.options.platform,
          arch: this.options.arch,
        });
        canAutoInstall = true;
      }

      // Keep the previously verified updater usable until all new metadata passes.
      // A download started during this check owns its release through installation.
      if (this.isUpdateStateActive()) return this.snapshotNow();
      this.detachUpdaterError?.();
      this.release = release;
      this.updater = candidateUpdater;
      this.updaterError = undefined;
      this.detachUpdaterError = detachCandidateError;
      detachCandidateError = undefined;
      return this.snapshot = {
        status: "available",
        currentVersion: this.options.currentVersion,
        currentVersionCode: this.options.currentVersionCode,
        canAutoInstall,
        ...(!canAutoInstall ? { error: "当前更新无法自动安装，请前往官网下载最新版本" } : {}),
        latestVersion: release.version,
        latestVersionCode: release.versionCode,
        ...(this.options.previousInstallFailure?.versionCode === release.versionCode
          ? { installWarning: "上次安装未完成，请重新尝试或前往官网下载最新版本" } : {}),
        checkedAtMillis: this.now(),
        ...(release.releaseNotes === undefined ? {} : { releaseNotes: release.releaseNotes }),
      };
    } catch (error) {
      if (this.isUpdateStateActive()) return this.snapshotNow();
      this.release = undefined;
      this.detachUpdaterError?.();
      this.updater = undefined;
      return this.snapshot = {
        status: "failed",
        currentVersion: this.options.currentVersion,
        currentVersionCode: this.options.currentVersionCode,
        canAutoInstall: false,
        failureStage: "check",
        error: error instanceof Error ? error.message : String(error),
        ...(discoveredRelease === undefined ? {} : {
          latestVersion: discoveredRelease.version,
          latestVersionCode: discoveredRelease.versionCode,
          ...(discoveredRelease.releaseNotes === undefined ? {} : { releaseNotes: discoveredRelease.releaseNotes }),
        }),
      };
    } finally {
      detachCandidateError?.();
    }
  }

  private setCurrent(): ArkmeAppUpdateSnapshot {
    this.release = undefined;
    this.detachUpdaterError?.();
    this.updater = undefined;
    return this.snapshot = {
      status: "current",
      currentVersion: this.options.currentVersion,
      currentVersionCode: this.options.currentVersionCode,
      canAutoInstall: false,
      noUpdateAvailable: true,
      checkedAtMillis: this.now(),
    };
  }

  private isUpdateStateActive(): boolean {
    return this.snapshot.status === "downloading"
      || this.snapshot.status === "downloaded"
      || this.snapshot.status === "installing";
  }

  download(): Promise<ArkmeAppUpdateSnapshot> {
    if (this.downloadInFlight !== undefined) return this.downloadInFlight;
    if (this.snapshot.status === "downloaded" || this.snapshot.status === "installing") {
      return Promise.resolve(this.snapshotNow());
    }
    const task = this.performDownload();
    this.downloadInFlight = task;
    const clear = () => {
      if (this.downloadInFlight === task) this.downloadInFlight = undefined;
    };
    void task.then(clear, clear);
    return task;
  }

  private async performDownload(): Promise<ArkmeAppUpdateSnapshot> {
    const release = this.release;
    if (release === undefined) {
      // A stale download/retry action must not hide the original check failure.
      if (this.snapshot.status === "failed" && this.snapshot.failureStage === "check") return this.snapshotNow();
      return this.fail("download", "请先检查更新");
    }
    if (!this.snapshot.canAutoInstall || this.updater === undefined) {
      return this.fail("download", "当前更新无法自动安装，请前往官网下载最新版本");
    }
    this.updaterError = undefined;
    const { error: _error, failureStage: _failureStage, totalBytes: _totalBytes, ...downloadSnapshot } = this.snapshot;
    this.snapshot = { ...downloadSnapshot, status: "downloading", downloadedBytes: 0 };
    try {
      return await this.downloadWithUpdater();
    } catch (error) {
      return this.fail("download", error instanceof Error ? error.message : String(error));
    }
  }

  private async downloadWithUpdater(): Promise<ArkmeAppUpdateSnapshot> {
    const updater = this.updater;
    if (updater === undefined) throw new Error("自动更新器尚未就绪");
    const onProgress = (progress: AppUpdaterProgress): void => {
      if (this.snapshot.status !== "downloading") return;
      this.snapshot = {
        ...this.snapshot,
        downloadedBytes: progress.transferred,
        ...(progress.total > 0 ? { totalBytes: progress.total } : {}),
      };
    };
    updater.on("download-progress", onProgress);
    try {
      const files = await updater.downloadUpdate();
      if (this.updaterError !== undefined) throw this.updaterError;
      const downloadedFilePath = files[0];
      return this.snapshot = {
        ...this.snapshot,
        status: "downloaded",
        ...(downloadedFilePath === undefined ? {} : { downloadedFilePath }),
      };
    } finally {
      updater.removeListener("download-progress", onProgress);
    }
  }

  install(): Promise<ArkmeAppUpdateSnapshot> {
    if (this.installInFlight !== undefined) return this.installInFlight;
    if (this.snapshot.status === "installing") return Promise.resolve(this.snapshotNow());
    const task = this.performInstall();
    this.installInFlight = task;
    const clear = () => {
      if (this.installInFlight === task) this.installInFlight = undefined;
    };
    void task.then(clear, clear);
    return task;
  }

  private async performInstall(): Promise<ArkmeAppUpdateSnapshot> {
    const release = this.release;
    const updater = this.updater;
    if (this.snapshot.status !== "downloaded" || !this.snapshot.canAutoInstall
      || release === undefined || updater === undefined || this.options.installUpdate === undefined) {
      return this.fail("install", "没有可安装的应用内更新");
    }
    this.updaterError = undefined;
    const { error: _error, failureStage: _failureStage, ...installSnapshot } = this.snapshot;
    this.snapshot = { ...installSnapshot, status: "installing" };
    try {
      await this.options.installUpdate(
        { version: release.version, versionCode: release.versionCode },
        () => updater.quitAndInstall(true, true),
      );
      return this.snapshotNow();
    } catch (error) {
      return this.fail("install", error instanceof Error ? error.message : String(error));
    }
  }

  private fail(stage: ArkmeAppUpdateFailureStage, error: string): ArkmeAppUpdateSnapshot {
    return this.snapshot = { ...this.snapshot, status: "failed", failureStage: stage, error };
  }
}
