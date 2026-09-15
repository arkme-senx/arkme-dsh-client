import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { RuntimeArtifactValidationError } from "./errors.js";

export interface DownloadArtifactIdentity {
  url: string;
  sha256: string;
  size: number;
}

interface DownloadRuntimeArtifactOptions {
  artifact: DownloadArtifactIdentity;
  destination: string;
  fetcher: typeof fetch;
  onProgress?: (percent: number) => void;
  idleTimeoutMs?: number;
  retryDelaysMs?: number[];
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}

export async function downloadRuntimeArtifact(
  options: DownloadRuntimeArtifactOptions
): Promise<string> {
  const retryDelays = options.retryDelaysMs ?? [0, 2_000, 4_000, 8_000, 16_000];
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let lastProgress = -1;
  const attemptOptions: DownloadRuntimeArtifactOptions = {
    ...options,
    onProgress: percent => {
      if (percent === lastProgress) return;
      lastProgress = percent;
      options.onProgress?.(percent);
    }
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    options.signal?.throwIfAborted();
    const delay = retryDelays[attempt] ?? 0;
    if (delay > 0) await sleep(delay);
    try {
      return await downloadRuntimeArtifactOnce(attemptOptions);
    } catch (error) {
      lastError = error;
      if (error instanceof RuntimeDownloadError && error.permanent) throw error;
    }
  }
  throw lastError;
}

async function downloadRuntimeArtifactOnce(
  options: DownloadRuntimeArtifactOptions
): Promise<string> {
  const { artifact, destination, fetcher } = options;
  await mkdir(path.dirname(destination), { recursive: true });
  if (await fileMatches(destination, artifact)) return destination;
  const partialPath = `${destination}.part`;
  let offset = await fileSize(partialPath);
  if (offset === artifact.size) {
    if (await fileMatches(partialPath, artifact)) {
      await rm(destination, { force: true });
      await rename(partialPath, destination);
      options.onProgress?.(100);
      return destination;
    }
    await rm(partialPath, { force: true });
    offset = 0;
  }
  if (offset > artifact.size) {
    await rm(partialPath, { force: true });
    offset = 0;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), options.idleTimeoutMs ?? 30_000);
  };
  resetIdleTimer();
  let responseBody: ReadableStream<Uint8Array> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const requestInit: RequestInit = {
      method: "GET",
      redirect: "manual",
      signal: controller.signal
    };
    if (offset > 0) requestInit.headers = { Range: `bytes=${offset}-` };
    let response: Response;
    try { response = await fetcher(artifact.url, requestInit); }
    catch (error) {
      if (options.signal?.aborted) throw error;
      throw new RuntimeNetworkWaitingError("网络请求失败", {cause:error});
    }
    responseBody = response.body;
    if (response.status >= 300 && response.status < 400) {
      throw new RuntimeDownloadError(`Runtime artifact redirect HTTP ${response.status} is not allowed`, true);
    }
    if (offset > 0) {
      if (response.status === 200) {
        await rm(partialPath, { force: true });
        offset = 0;
      } else if (response.status === 206) {
        if (!validContentRange(response.headers.get("content-range"), offset, artifact.size)) {
          throw new RuntimeDownloadError("Runtime artifact server returned an invalid Range response", true);
        }
      } else {
        throw new RuntimeDownloadError(
          `Runtime artifact returned HTTP ${response.status}`,
          response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
        );
      }
    } else if (response.status !== 200) {
      throw new RuntimeDownloadError(
        `Runtime artifact returned HTTP ${response.status}`,
        response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      );
    }
    if (response.body === null) throw new Error("Runtime artifact response body is empty");
    const file = await open(partialPath, offset === 0 ? "w" : "a", 0o600);
    let written = offset;
    try {
      reader = response.body.getReader();
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch (error) {
          if (options.signal?.aborted) throw error;
          throw new RuntimeNetworkWaitingError("下载连接中断", {cause:error});
        }
        if (chunk.done) break;
        resetIdleTimer();
        if (written > artifact.size - chunk.value.byteLength) {
          throw new RuntimeArtifactValidationError("ARTIFACT_SIZE_MISMATCH", "Runtime artifact exceeds its declared size", "download");
        }
        await file.write(chunk.value);
        written += chunk.value.byteLength;
        options.onProgress?.(Math.min(100, Math.floor((written / artifact.size) * 100)));
      }
      await file.sync();
    } finally {
      await file.close();
    }
    if (written !== artifact.size) {
      throw new RuntimeNetworkWaitingError(`Runtime download interrupted: expected ${artifact.size}, received ${written}`);
    }
    const digest = await sha256File(partialPath);
    if (digest !== artifact.sha256) {
      await rm(partialPath, { force: true });
      throw new RuntimeArtifactValidationError("ARTIFACT_DIGEST_MISMATCH", "Runtime artifact SHA-256 mismatch", "download");
    }
    await rm(destination, { force: true });
    await rename(partialPath, destination);
    options.onProgress?.(100);
    return destination;
  } catch (error) {
    // Stop this transfer before detaching its parent cancellation listener.
    // The installer's sibling abort arrives only after this promise rejects.
    controller.abort(error);
    try {
      if (reader !== undefined) await reader.cancel(error);
      else await responseBody?.cancel(error);
    } catch {
      // Cleanup AbortError must not replace the HTTP/digest/size failure.
    }
    throw error;
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export class RuntimeDownloadError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
    this.name = "RuntimeDownloadError";
  }
}

export class RuntimeNetworkWaitingError extends RuntimeDownloadError {
  readonly displayTitle = "需要联网完成运行环境升级";
  readonly suggestion = "已下载进度和本地数据会保留。\n\n网络恢复后，请点击“重试”继续。";
  readonly showWorkspaceAction = false;
  constructor(readonly technicalDetails: string, options?: ErrorOptions) {
    super("需要联网完成运行环境升级", false);
    this.name = "RuntimeNetworkWaitingError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

async function fileMatches(filePath: string, artifact: DownloadArtifactIdentity): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size === artifact.size && await sha256File(filePath) === artifact.sha256;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function validContentRange(value: string | null, offset: number, total: number): boolean {
  if (value === null) return false;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  return match !== null
    && Number(match[1]) === offset
    && Number(match[2]) === total - 1
    && Number(match[3]) === total;
}
