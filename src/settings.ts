import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeEnvironment } from "./runtime/service-config.js";

interface PersistedSettings {
  lastWorkspace: string;
}

export async function ensureDefaultWorkspace(userDataPath: string): Promise<string> {
  const workspacePath = path.join(path.resolve(userDataPath), "workspace");
  await mkdir(workspacePath, { recursive: true });
  return workspacePath;
}

export function resolveUserDataPath(
  appDataPath: string,
  environment: RuntimeEnvironment = "prod"
): string {
  return path.join(appDataPath, environment === "test" ? "Arkme Harness Test" : "Arkme Harness");
}

export function resolveAppUpdateDownloadsPath(
  environment: RuntimeEnvironment,
  userDataPath: string,
  defaultDownloadsPath: string
): string {
  return environment === "test"
    ? path.join(userDataPath, "app-updates")
    : defaultDownloadsPath;
}

export function resolveAppUpdateInstallReceiptPath(userDataPath: string): string {
  return path.join(userDataPath, "app-update-install.json");
}

export function resolveArkmeAppDataPath(defaultAppDataPath: string, override: string | undefined): string {
  const candidate = override?.trim();
  if (candidate === undefined || candidate === "") return defaultAppDataPath;
  if (!path.isAbsolute(candidate)) {
    throw new Error("ARKME_APP_DATA_PATH must be an absolute path");
  }
  return path.resolve(candidate);
}

export async function loadLastWorkspace(settingsPath: string): Promise<string | null> {
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedSettings(parsed)) return null;

    const workspace = await stat(parsed.lastWorkspace);
    return workspace.isDirectory() ? parsed.lastWorkspace : null;
  } catch {
    return null;
  }
}

export async function saveLastWorkspace(
  settingsPath: string,
  workspacePath: string
): Promise<void> {
  const resolvedWorkspace = path.resolve(workspacePath);
  const workspace = await stat(resolvedWorkspace);
  if (!workspace.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${resolvedWorkspace}`);
  }

  await mkdir(path.dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
  const contents = `${JSON.stringify({ lastWorkspace: resolvedWorkspace }, null, 2)}\n`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, settingsPath);
}

function isPersistedSettings(value: unknown): value is PersistedSettings {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.lastWorkspace === "string" && path.isAbsolute(candidate.lastWorkspace);
}
