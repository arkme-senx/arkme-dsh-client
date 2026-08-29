import { parseElectronRuntimeManifest, type ElectronRuntimeManifest } from "./manifest.js";
import { RuntimeArtifactValidationError } from "./errors.js";
import { resolveRuntimeServiceOrigin } from "./service-config.js";

interface ElectronRuntimeTarget {
  os: "darwin" | "windows" | "linux";
  arch: "arm64" | "x64";
}

interface FetchElectronRuntimeManifestOptions {
  serviceBaseUrl: string;
  platform: NodeJS.Platform;
  arch: string;
  shellVersion: string;
  electronMajor: number;
  modulesAbi: number;
  fetcher: typeof fetch;
}

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

interface RuntimeManifestErrorPayload {
  code?: unknown;
  message?: unknown;
  suggestion?: unknown;
  current_version?: unknown;
  required_version?: unknown;
}

export class ElectronRuntimeManifestError extends Error {
  readonly displayTitle: string;
  readonly suggestion: string;
  readonly technicalDetails: string;
  readonly showWorkspaceAction = false;

  constructor(input: {
    displayTitle?: string;
    message: string;
    suggestion: string;
    technicalDetails: string;
  }) {
    super(input.message);
    this.name = "ElectronRuntimeManifestError";
    this.displayTitle = input.displayTitle ?? "运行环境暂时不可用";
    this.suggestion = input.suggestion;
    this.technicalDetails = input.technicalDetails;
  }
}

export function resolveElectronRuntimeTarget(
  platform: string,
  arch: string
): ElectronRuntimeTarget | null {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return { os: "darwin", arch };
  }
  if (platform === "win32" && arch === "x64") return { os: "windows", arch: "x64" };
  if (platform === "linux" && arch === "x64") return { os: "linux", arch: "x64" };
  return null;
}

export async function fetchElectronRuntimeManifest(
  options: FetchElectronRuntimeManifestOptions
): Promise<ElectronRuntimeManifest> {
  const target = resolveElectronRuntimeTarget(options.platform, options.arch);
  if (target === null) throw new Error(`Electron runtime target is unsupported: ${options.platform}/${options.arch}`);
  const trustedOrigin = resolveRuntimeServiceOrigin(options.serviceBaseUrl);
  const base = new URL(options.serviceBaseUrl);
  if (
    base.protocol !== "https:"
    || base.origin !== trustedOrigin
    || base.pathname !== "/"
    || base.port !== ""
    || base.username !== ""
    || base.password !== ""
    || base.search !== ""
    || base.hash !== ""
  ) {
    throw new Error("Electron runtime service origin is not trusted");
  }
  const endpoint = new URL(
    `/api/public/v1/arkme/electron-runtime-update/${target.os}/${target.arch}/latest`,
    base
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    let response: Response;
    try {
      response = await options.fetcher(endpoint.href, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal
      });
    } catch {
      throw new ElectronRuntimeManifestError({
        displayTitle: "无法连接运行环境服务",
        message: "未能连接到运行环境服务，请检查网络连接后重试。",
        suggestion: "如果网络正常但问题持续出现，请联系管理员。",
        technicalDetails: "网络请求失败"
      });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Electron runtime manifest redirect HTTP ${response.status} is not allowed`);
    }
    if (response.status !== 200) {
      throw await runtimeManifestResponseError(response);
    }
    const declaredHeader = response.headers.get("content-length");
    if (declaredHeader !== null && (!/^\d+$/.test(declaredHeader) || Number(declaredHeader) > MAX_MANIFEST_BYTES)) {
      throw new Error("Electron runtime manifest is too large");
    }
    const bytes = await readLimitedManifest(response);
    if (bytes.byteLength === 0) {
      throw new Error("Electron runtime manifest size is outside accepted bounds");
    }
    return parseElectronRuntimeManifest(JSON.parse(new TextDecoder().decode(bytes)) as unknown, {
      os: target.os,
      arch: target.arch,
      shellVersion: options.shellVersion,
      electronMajor: options.electronMajor,
      modulesAbi: options.modulesAbi
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function runtimeManifestResponseError(response: Response): Promise<ElectronRuntimeManifestError> {
  let payload: RuntimeManifestErrorPayload = {};
  try {
    const bytes = await readLimitedErrorResponse(response);
    if (bytes.byteLength > 0) {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as RuntimeManifestErrorPayload;
      }
    }
  } catch {
    // A malformed server response still gets a safe, user-readable fallback below.
  }
  const message = boundedString(payload.message, 500)
    ?? (response.status === 404
      ? "服务器尚未提供适用于当前设备的运行环境。"
      : "运行环境服务暂时不可用。");
  const suggestion = boundedString(payload.suggestion, 300)
    ?? "请稍后重试；如果问题持续出现，请联系管理员。";
  const currentVersion = boundedString(payload.current_version, 80);
  const requiredVersion = boundedString(payload.required_version, 80);
  const requestID = boundedString(response.headers.get("x-request-id"), 160);
  const technical: string[] = [];
  if (currentVersion !== undefined && requiredVersion !== undefined) {
    technical.push(`插件版本 ${currentVersion}，最低要求 ${requiredVersion}`);
  } else {
    technical.push(`服务响应状态 HTTP ${response.status}`);
    if (requestID !== undefined) technical.push(`问题编号 ${requestID}`);
  }
  return new ElectronRuntimeManifestError({
    message,
    suggestion,
    technicalDetails: technical.join(" · ")
  });
}

async function readLimitedErrorResponse(response: Response): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_ERROR_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return new Uint8Array();
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized !== "" && normalized.length <= maxLength ? normalized : undefined;
}

async function readLimitedManifest(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new Error("Electron runtime manifest response body is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_MANIFEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Electron runtime manifest is too large");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function verifyElectronRuntimePluginHealth(
  harnessOrigin: string,
  expectedVersion: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const origin = new URL(harnessOrigin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username !== "" || origin.password !== "") {
    throw new Error("Electron runtime health origin is not trusted loopback");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(new URL("/arkme-self/api", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "plugin.update.status" }),
      redirect: "manual",
      signal: controller.signal
    });
    const body = response.status === 200
      ? await response.json() as { ok?: unknown; value?: { installedVersion?: unknown } }
      : undefined;
    if (body?.ok === true && typeof body.value?.installedVersion === "string" && body.value.installedVersion !== expectedVersion) {
      throw new RuntimeArtifactValidationError(
        "PLUGIN_IDENTITY_MISMATCH",
        `Electron runtime plugin identity mismatch: expected ${expectedVersion}, received ${body.value.installedVersion}`,
        "plugin-health"
      );
    }
    if (body?.ok !== true || body.value?.installedVersion !== expectedVersion) {
      throw new Error(`Electron runtime plugin health check failed for ${expectedVersion}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
