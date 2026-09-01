import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
  | "failed";

export interface ArkmeAppUpdateSnapshot {
  status: ArkmeAppUpdateStatus;
  currentVersion: string;
  checkedAtMillis?: number;
  noUpdateAvailable?: boolean;
  latestVersion?: string;
  releaseNotes?: string;
  error?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  downloadedFilePath?: string;
}

type ArkmeAppUpdateControllerOptions = {
  currentVersion: string;
  applicationName?: "arkme" | "arkme Test" | "arkme Local Test";
  serviceBaseUrl: string;
  platform: UpdatePlatform;
  arch: UpdateArch;
  downloadsDirectory: string;
  fetchImpl?: typeof fetch;
  updater?: unknown;
};

export function shouldForceDevAppUpdate(
  isPackaged: boolean,
  environment: { ARKME_FORCE_DEV_APP_UPDATE?: string } = process.env,
): boolean {
  return !isPackaged && environment.ARKME_FORCE_DEV_APP_UPDATE === "1";
}

function origin(raw: string): string {
  const value = new URL(raw);
  if (value.protocol !== "https:" || value.username || value.password || value.pathname !== "/" || value.search || value.hash) {
    throw new Error("Arkme app update service base URL must be an HTTPS origin");
  }
  return value.origin;
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
  private downloadURL?: string;

  constructor(private readonly options: ArkmeAppUpdateControllerOptions) {
    this.snapshot = { status: "idle", currentVersion: options.currentVersion };
    this.feedURL = appUpdateFeedURL(options.serviceBaseUrl, options.platform, options.arch);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  snapshotNow(): ArkmeAppUpdateSnapshot {
    return { ...this.snapshot };
  }

  async checkNow(): Promise<ArkmeAppUpdateSnapshot> {
    const { error: _error, ...checkingSnapshot } = this.snapshot;
    this.snapshot = { ...checkingSnapshot, status: "checking" };
    try {
      const response = await this.fetchImpl(this.feedURL, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404) {
        return this.snapshot = {
          ...this.snapshot,
          status: "current",
          noUpdateAvailable: true,
          checkedAtMillis: Date.now(),
        };
      }
      if (!response.ok) throw new Error(`更新服务返回 HTTP ${response.status}`);
      const body = await response.json() as {
        version?: unknown;
        releaseNotes?: unknown;
        downloadUrl?: unknown;
      };
      if (typeof body.version !== "string" || typeof body.downloadUrl !== "string" || new URL(body.downloadUrl).protocol !== "https:") {
        throw new Error("更新服务返回格式无效");
      }
      this.downloadURL = body.downloadUrl;
      const releaseNotes = typeof body.releaseNotes === "string" ? body.releaseNotes : undefined;
      const { releaseNotes: _previousReleaseNotes, ...releaseSnapshot } = this.snapshot;
      return this.snapshot = body.version === this.snapshot.currentVersion
        ? {
          ...releaseSnapshot,
          status: "current",
          checkedAtMillis: Date.now(),
          ...(releaseNotes === undefined ? {} : { releaseNotes }),
        }
        : {
          ...releaseSnapshot,
          status: "available",
          latestVersion: body.version,
          checkedAtMillis: Date.now(),
          ...(releaseNotes === undefined ? {} : { releaseNotes }),
        };
    } catch (error) {
      return this.snapshot = {
        ...this.snapshot,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async download(): Promise<ArkmeAppUpdateSnapshot> {
    if (!this.downloadURL || !this.snapshot.latestVersion) {
      return this.snapshot = { ...this.snapshot, status: "failed", error: "请先检查更新" };
    }
    const {
      error: _error,
      downloadedBytes: _downloadedBytes,
      totalBytes: _totalBytes,
      downloadedFilePath: _downloadedFilePath,
      ...downloadSnapshot
    } = this.snapshot;
    this.snapshot = {
      ...downloadSnapshot,
      status: "downloading",
      downloadedBytes: 0,
    };
    try {
      const response = await this.fetchImpl(this.downloadURL, {
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`下载更新包失败（HTTP ${response.status}）`);
      const totalBytes = contentLength(response);
      this.snapshot = totalBytes === undefined
        ? this.snapshot
        : { ...this.snapshot, totalBytes };
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
        `${this.options.applicationName ?? "arkme"}-${this.snapshot.latestVersion}-${this.options.platform}-${this.options.arch}${suffix(this.options.platform)}`,
      );
      await writeFile(file, Buffer.concat(chunks));
      return this.snapshot = {
        ...this.snapshot,
        status: "downloaded",
        downloadedBytes,
        totalBytes: totalBytes ?? downloadedBytes,
        downloadedFilePath: file,
      };
    } catch (error) {
      return this.snapshot = {
        ...this.snapshot,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
