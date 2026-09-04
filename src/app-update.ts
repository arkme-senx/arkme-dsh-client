import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_APP_VERSION_CODE } from "./app-version-code.js";

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

export type ArkmeAppUpdateInstallMode = "in-app" | "manual";
export type ArkmeAppUpdateFailureStage = "check" | "download" | "install";

export interface ArkmeAppUpdateSnapshot {
  status: ArkmeAppUpdateStatus;
  currentVersion: string;
  currentVersionCode: number;
  installMode: ArkmeAppUpdateInstallMode;
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
}

export interface AppUpdaterProgress {
  transferred: number;
  total: number;
}

export interface AppUpdaterUpdateInfo {
  version: string;
  files: Array<{ url: string; sha512?: string; size?: number }>;
}

export interface AppUpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: AppUpdaterUpdateInfo } | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "download-progress", listener: (progress: AppUpdaterProgress) => void): this;
  removeListener(event: "download-progress", listener: (progress: AppUpdaterProgress) => void): this;
}

export interface PendingAppUpdateInstall {
  version: string;
  versionCode: number;
}

type ArkmeAppUpdateControllerOptions = {
  currentVersion: string;
  currentVersionCode: number;
  applicationName?: "arkme" | "arkme Test" | "arkme Local Test";
  serviceBaseUrl: string;
  platform: UpdatePlatform;
  arch: UpdateArch;
  downloadsDirectory: string;
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
  downloadURL: string;
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

function hasVersionCode(filename: string, versionCode: number): boolean {
  return new RegExp(`(?:^|[-_.])vc${versionCode}(?:[-_.]|$)`, "i").test(filename);
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

function suffix(platform: UpdatePlatform): string {
  return platform === "darwin" ? ".zip" : platform === "win32" ? ".exe" : ".AppImage";
}

function contentLength(response: Response): number | undefined {
  const value = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export class ArkmeAppUpdateController {
  private snapshot: ArkmeAppUpdateSnapshot;
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
          installMode: "manual",
        }
      : {
          status: "failed",
          currentVersion: options.currentVersion,
          currentVersionCode: options.currentVersionCode,
          installMode: "in-app",
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
    let failureInstallMode: ArkmeAppUpdateInstallMode = "manual";
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
        downloadUrl?: unknown;
        updateFeedUrl?: unknown;
      };
      if (typeof body.version !== "string" || body.version.trim() === "" || typeof body.downloadUrl !== "string") {
        throw new Error("更新服务返回格式无效");
      }
      const downloadURL = secureURL(body.downloadUrl, "安装包地址").href;
      if (!Number.isSafeInteger(body.versionCode) || (body.versionCode as number) < 0 || (body.versionCode as number) > MAX_APP_VERSION_CODE) {
        throw new Error("更新服务返回的 Version Code 无效");
      }
      if (this.isUpdateStateActive()) return this.snapshotNow();
      if ((body.versionCode as number) <= this.options.currentVersionCode) return this.setCurrent();

      const updateFeedURL = typeof body.updateFeedUrl === "string" && body.updateFeedUrl.trim() !== ""
        ? body.updateFeedUrl
        : undefined;
      if (updateFeedURL !== undefined) failureInstallMode = "in-app";

      const release: AppUpdateRelease = {
        version: body.version,
        versionCode: body.versionCode as number,
        downloadURL,
        ...(typeof body.releaseNotes === "string" ? { releaseNotes: body.releaseNotes } : {}),
        ...(updateFeedURL !== undefined
          ? { updateFeedURL: updateFeedDirectory(updateFeedURL) }
          : {}),
      };
      this.release = release;
      this.updater = undefined;

      let installMode: ArkmeAppUpdateInstallMode = "manual";
      if (release.updateFeedURL !== undefined) {
        if (this.options.platform === "linux" || this.options.createUpdater === undefined) {
          throw new Error("当前应用不支持此自动更新目录");
        }
        const updater = this.options.createUpdater(release.updateFeedURL, release.version);
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        // This flag is deliberately enabled only after the Version Code gate above.
        updater.allowDowngrade = true;
        const result = await updater.checkForUpdates();
        if (result === null || !result.isUpdateAvailable) throw new Error("自动更新元数据未返回可安装版本");
        this.validateUpdaterMetadata(release, result.updateInfo);
        this.updater = updater;
        installMode = "in-app";
      }

      return this.snapshot = {
        status: "available",
        currentVersion: this.options.currentVersion,
        currentVersionCode: this.options.currentVersionCode,
        installMode,
        latestVersion: release.version,
        latestVersionCode: release.versionCode,
        checkedAtMillis: this.now(),
        ...(release.releaseNotes === undefined ? {} : { releaseNotes: release.releaseNotes }),
      };
    } catch (error) {
      if (this.isUpdateStateActive()) return this.snapshotNow();
      this.release = undefined;
      this.updater = undefined;
      return this.snapshot = {
        status: "failed",
        currentVersion: this.options.currentVersion,
        currentVersionCode: this.options.currentVersionCode,
        installMode: failureInstallMode,
        failureStage: "check",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private validateUpdaterMetadata(release: AppUpdateRelease, info: AppUpdaterUpdateInfo): void {
    if (info.version !== release.version) throw new Error("自动更新元数据版本与发布记录不一致");
    const matchingFile = info.files.find(file => {
      try {
        return new URL(file.url, release.updateFeedURL).href === release.downloadURL;
      } catch {
        return false;
      }
    });
    if (matchingFile === undefined) throw new Error("自动更新元数据安装包地址与发布记录不一致");
    const filename = decodeURIComponent(path.posix.basename(new URL(release.downloadURL).pathname));
    if (!hasVersionCode(filename, release.versionCode)) throw new Error("安装包文件名缺少对应的 Version Code");
    if (typeof matchingFile.sha512 !== "string" || matchingFile.sha512.trim() === "") {
      throw new Error("自动更新元数据缺少 SHA-512");
    }
    if (!Number.isSafeInteger(matchingFile.size) || (matchingFile.size as number) <= 0) {
      throw new Error("自动更新元数据文件大小无效");
    }
  }

  private setCurrent(): ArkmeAppUpdateSnapshot {
    this.release = undefined;
    this.updater = undefined;
    return this.snapshot = {
      status: "current",
      currentVersion: this.options.currentVersion,
      currentVersionCode: this.options.currentVersionCode,
      installMode: "manual",
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
    if (release === undefined) return this.fail("download", "请先检查更新");
    const { error: _error, failureStage: _failureStage, ...downloadSnapshot } = this.snapshot;
    this.snapshot = { ...downloadSnapshot, status: "downloading", downloadedBytes: 0 };
    try {
      if (this.snapshot.installMode === "in-app") return await this.downloadWithUpdater();
      return await this.downloadManual(release);
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

  private async downloadManual(release: AppUpdateRelease): Promise<ArkmeAppUpdateSnapshot> {
    const response = await this.fetchImpl(release.downloadURL, {
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`下载更新包失败（HTTP ${response.status}）`);
    const totalBytes = contentLength(response);
    if (totalBytes !== undefined) this.snapshot = { ...this.snapshot, totalBytes };
    const chunks: Buffer[] = [];
    let downloadedBytes = 0;
    if (response.body === null) {
      const bytes = Buffer.from(await response.arrayBuffer());
      chunks.push(bytes);
      downloadedBytes = bytes.byteLength;
      this.snapshot = { ...this.snapshot, downloadedBytes };
    } else {
      const reader = response.body.getReader();
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const bytes = Buffer.from(result.value);
        chunks.push(bytes);
        downloadedBytes += bytes.byteLength;
        this.snapshot = { ...this.snapshot, downloadedBytes };
      }
    }
    await mkdir(this.options.downloadsDirectory, { recursive: true });
    const file = path.join(
      this.options.downloadsDirectory,
      `${this.options.applicationName ?? "arkme"}-${release.version}-${this.options.platform}-${this.options.arch}${suffix(this.options.platform)}`,
    );
    await writeFile(file, Buffer.concat(chunks));
    return this.snapshot = {
      ...this.snapshot,
      status: "downloaded",
      downloadedBytes,
      totalBytes: totalBytes ?? downloadedBytes,
      downloadedFilePath: file,
    };
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
    if (this.snapshot.status !== "downloaded" || this.snapshot.installMode !== "in-app"
      || release === undefined || updater === undefined || this.options.installUpdate === undefined) {
      return this.fail("install", "没有可安装的应用内更新");
    }
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
