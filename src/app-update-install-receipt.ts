import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_APP_VERSION_CODE } from "./app-version-code.js";
import type { PendingAppUpdateInstall } from "./app-update.js";

interface PersistedAppUpdateInstall extends PendingAppUpdateInstall {
  requestedAt: string;
}

export type AppUpdateInstallReconciliation =
  | { outcome: "none" }
  | { outcome: "succeeded"; target: PendingAppUpdateInstall }
  | { outcome: "incomplete"; target: PendingAppUpdateInstall };

function parseReceipt(raw: string): PersistedAppUpdateInstall | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.version !== "string" || value.version.trim() === ""
      || !Number.isSafeInteger(value.versionCode) || (value.versionCode as number) <= 0
      || (value.versionCode as number) > MAX_APP_VERSION_CODE
      || typeof value.requestedAt !== "string") return undefined;
    return {
      version: value.version,
      versionCode: value.versionCode as number,
      requestedAt: value.requestedAt,
    };
  } catch {
    return undefined;
  }
}

export async function writePendingAppUpdateInstall(
  receiptPath: string,
  target: PendingAppUpdateInstall,
): Promise<void> {
  if (!Number.isSafeInteger(target.versionCode) || target.versionCode <= 0 || target.versionCode > MAX_APP_VERSION_CODE) {
    throw new Error("Cannot persist an invalid target Version Code");
  }
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  const contents = `${JSON.stringify({ ...target, requestedAt: new Date().toISOString() }, null, 2)}\n`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, receiptPath);
}

export async function clearPendingAppUpdateInstall(receiptPath: string): Promise<void> {
  try {
    await unlink(receiptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function reconcilePendingAppUpdateInstall(
  receiptPath: string,
  currentVersionCode: number,
): Promise<AppUpdateInstallReconciliation> {
  let receipt: PersistedAppUpdateInstall | undefined;
  try {
    receipt = parseReceipt(await readFile(receiptPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "none" };
    throw error;
  }
  if (receipt === undefined) return { outcome: "none" };
  const target = { version: receipt.version, versionCode: receipt.versionCode };
  if (currentVersionCode < receipt.versionCode) return { outcome: "incomplete", target };
  await clearPendingAppUpdateInstall(receiptPath);
  return { outcome: "succeeded", target };
}
