import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

const PROFILE_NAME = "web";
const RECEIPT_FILE_NAME = "receipt.json";
const PROFILE_BACKUP_FILE_NAME = "profile-package.json.before";
const QUARANTINE_DIRECTORY_NAME = "desktop-extension-quarantine";
const MAX_FAILURE_TAIL_LENGTH = 16_384;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MODULE_FAILURE_PATTERN = /(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|cannot find (?:package|module)|cannot resolve|failed to (?:load|import|resolve)|unable to (?:load|import|resolve)|bundle[^\n]*failed|failed[^\n]*bundle)/i;
const BUNDLE_CONTEXT_PATTERN = /(?:\bbundle\b|\bcordis\b|\bplugin\b|\bloader\b|profile[^\n]*(?:apply|compose))/i;

export type RuntimeEnvironment = "prod" | "test";
export type DesktopExtensionQuarantinePhase = "pending" | "active" | "restored" | "resolved";

export interface DesktopExtensionQuarantineEntry {
  packageName: string;
  dependencySpec: string;
  originalBundleIndex: number;
  synchronizedAtMillis?: number;
  notificationDismissedAtMillis?: number;
  reenableRequestedAtMillis?: number;
  resolvedAtMillis?: number;
}

export interface DesktopExtensionQuarantineReceipt {
  schemaVersion: 1;
  quarantineId: string;
  environment: RuntimeEnvironment;
  phase: DesktopExtensionQuarantinePhase;
  mode: "targeted" | "local-safe-mode";
  createdAtMillis: number;
  updatedAtMillis: number;
  runtimeReleaseId?: string;
  failureSummary: string;
  failureLogTail: string;
  entries: DesktopExtensionQuarantineEntry[];
}

export interface OptionalExtensionRecoveryConfig {
  dshHome: string;
  environment: RuntimeEnvironment;
  runtimeReleaseId?: string;
}

export interface PrepareOptionalExtensionRecoveryInput extends OptionalExtensionRecoveryConfig {
  failureText: string;
}

export interface OptionalExtensionRecoveryTransaction {
  profilePath: string;
  receiptPath: string;
  backupPath: string;
  receipt: DesktopExtensionQuarantineReceipt;
}

interface ProfileCandidate extends DesktopExtensionQuarantineEntry {
  matchValues: string[];
  local: boolean;
}

interface ParsedProfile {
  value: Record<string, unknown>;
  bundles: string[];
  candidates: ProfileCandidate[];
}

export async function prepareOptionalExtensionRecovery(
  input: PrepareOptionalExtensionRecoveryInput
): Promise<OptionalExtensionRecoveryTransaction | undefined> {
  const profilePath = profileManifestPath(input.dshHome);
  const originalText = await readFile(profilePath, "utf8");
  const parsed = parseProfile(originalText, path.dirname(profilePath));
  const selection = selectCandidates(parsed.candidates, input.failureText);
  if (selection === undefined) return undefined;

  const now = Date.now();
  const quarantineId = randomUUID();
  const receipt: DesktopExtensionQuarantineReceipt = {
    schemaVersion: 1,
    quarantineId,
    environment: input.environment,
    phase: "pending",
    mode: selection.mode,
    createdAtMillis: now,
    updatedAtMillis: now,
    ...(input.runtimeReleaseId === undefined ? {} : { runtimeReleaseId: input.runtimeReleaseId }),
    failureSummary: selection.mode === "targeted"
      ? `扩展 ${selection.entries[0]!.packageName} 启动时加载失败，已自动停用`
      : `无法确定具体故障扩展，已停用 ${selection.entries.length} 个本地开发扩展`,
    failureLogTail: sanitizedFailureTail(input.failureText),
    entries: selection.entries.map(({ matchValues: _matchValues, local: _local, ...entry }) => entry)
  };

  const quarantineRoot = quarantineDirectory(input.dshHome);
  await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
  const transactionDirectory = path.join(quarantineRoot, quarantineId);
  const temporaryDirectory = path.join(quarantineRoot, `.${quarantineId}.tmp`);
  await mkdir(temporaryDirectory, { mode: 0o700 });
  const receiptPath = path.join(transactionDirectory, RECEIPT_FILE_NAME);
  const backupPath = path.join(transactionDirectory, PROFILE_BACKUP_FILE_NAME);
  try {
    await Promise.all([
      writeSecureFile(path.join(temporaryDirectory, PROFILE_BACKUP_FILE_NAME), originalText),
      writeSecureFile(
        path.join(temporaryDirectory, RECEIPT_FILE_NAME),
        serializeReceipt(receipt)
      )
    ]);
    await rename(temporaryDirectory, transactionDirectory);

    const disabled = new Set(selection.entries.map((entry) => entry.packageName));
    setProfileBundles(parsed.value, parsed.bundles.filter((bundle) => !disabled.has(bundle)));
    const profileMode = (await stat(profilePath)).mode & 0o777;
    await writeTextAtomically(
      profilePath,
      `${JSON.stringify(parsed.value, undefined, 2)}\n`,
      profileMode === 0 ? 0o600 : profileMode
    );
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (await fileExists(backupPath)) {
      await writeTextAtomically(profilePath, originalText, 0o600).catch(() => undefined);
      await writeReceipt(receiptPath, { ...receipt, phase: "restored", updatedAtMillis: Date.now() })
        .catch(() => undefined);
    }
    throw error;
  }

  return { profilePath, receiptPath, backupPath, receipt };
}

export async function activateOptionalExtensionRecovery(
  transaction: OptionalExtensionRecoveryTransaction
): Promise<void> {
  const receipt = {
    ...transaction.receipt,
    phase: "active" as const,
    updatedAtMillis: Date.now()
  };
  await writeReceipt(transaction.receiptPath, receipt);
  transaction.receipt = receipt;
}

export async function restoreOptionalExtensionRecovery(
  transaction: OptionalExtensionRecoveryTransaction
): Promise<void> {
  const originalText = await readFile(transaction.backupPath, "utf8");
  const currentMode = await stat(transaction.profilePath)
    .then((value) => value.mode & 0o777)
    .catch(() => 0o600);
  await writeTextAtomically(
    transaction.profilePath,
    originalText,
    currentMode === 0 ? 0o600 : currentMode
  );
  const receipt = {
    ...transaction.receipt,
    phase: "restored" as const,
    updatedAtMillis: Date.now()
  };
  await writeReceipt(transaction.receiptPath, receipt);
  transaction.receipt = receipt;
}

export async function loadPendingOptionalExtensionRecovery(
  input: OptionalExtensionRecoveryConfig
): Promise<OptionalExtensionRecoveryTransaction | undefined> {
  const root = quarantineDirectory(input.dshHome);
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const pending: OptionalExtensionRecoveryTransaction[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = path.join(root, entry.name);
    const receiptPath = path.join(directory, RECEIPT_FILE_NAME);
    const backupPath = path.join(directory, PROFILE_BACKUP_FILE_NAME);
    try {
      const receipt = parseReceipt(await readFile(receiptPath, "utf8"));
      if (receipt.phase !== "pending" || receipt.environment !== input.environment) continue;
      await stat(backupPath);
      pending.push({
        profilePath: profileManifestPath(input.dshHome),
        receiptPath,
        backupPath,
        receipt
      });
    } catch {
      // Ignore malformed or incomplete transaction directories. They never authorize a Profile write.
    }
  }
  pending.sort((left, right) => right.receipt.createdAtMillis - left.receipt.createdAtMillis);
  const transaction = pending[0];
  if (transaction === undefined) return undefined;

  const profile = parseProfile(
    await readFile(transaction.profilePath, "utf8"),
    path.dirname(transaction.profilePath)
  );
  const currentBundles = new Set(profile.bundles);
  const disabledCount = transaction.receipt.entries.filter(
    (entry) => !currentBundles.has(entry.packageName)
  ).length;
  if (disabledCount === transaction.receipt.entries.length) return transaction;

  await restoreOptionalExtensionRecovery(transaction);
  return undefined;
}

/** Re-apply active quarantine facts after another Profile transaction restores an older manifest. */
export async function enforceActiveOptionalExtensionRecoveries(
  input: OptionalExtensionRecoveryConfig
): Promise<string[]> {
  const root = quarantineDirectory(input.dshHome);
  const directories = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const disabledPackages = new Set<string>();
  for (const directory of directories) {
    if (!directory.isDirectory() || directory.name.startsWith(".")) continue;
    try {
      const receipt = parseReceipt(await readFile(
        path.join(root, directory.name, RECEIPT_FILE_NAME),
        "utf8"
      ));
      if (receipt.phase !== "active" || receipt.environment !== input.environment) continue;
      for (const entry of receipt.entries) {
        if (entry.resolvedAtMillis === undefined && entry.reenableRequestedAtMillis === undefined) {
          disabledPackages.add(entry.packageName);
        }
      }
    } catch {
      // Malformed receipts never authorize a Profile mutation.
    }
  }
  if (disabledPackages.size === 0) return [];

  const profilePath = profileManifestPath(input.dshHome);
  const text = await readFile(profilePath, "utf8");
  const parsed = parseProfile(text, path.dirname(profilePath));
  const removed = parsed.bundles.filter((bundle) => disabledPackages.has(bundle));
  if (removed.length === 0) return [];
  setProfileBundles(parsed.value, parsed.bundles.filter((bundle) => !disabledPackages.has(bundle)));
  const profileMode = (await stat(profilePath)).mode & 0o777;
  await writeTextAtomically(
    profilePath,
    `${JSON.stringify(parsed.value, undefined, 2)}\n`,
    profileMode === 0 ? 0o600 : profileMode
  );
  return removed;
}

function selectCandidates(
  candidates: ProfileCandidate[],
  failureText: string
): { mode: "targeted" | "local-safe-mode"; entries: ProfileCandidate[] } | undefined {
  if (!MODULE_FAILURE_PATTERN.test(failureText)) return undefined;
  const normalizedFailure = normalizedMatchText(failureText);
  const exact = candidates.filter((candidate) => candidate.matchValues.some((value) =>
    value !== "" && normalizedFailure.includes(normalizedMatchText(value))
  ));
  if (exact.length === 1) return { mode: "targeted", entries: exact };

  if (exact.length === 0 && mentionsProtectedPackage(normalizedFailure)) return undefined;
  if (!BUNDLE_CONTEXT_PATTERN.test(failureText)) return undefined;
  const local = candidates.filter((candidate) => candidate.local);
  return local.length === 0 ? undefined : { mode: "local-safe-mode", entries: local };
}

function parseProfile(text: string, profileDirectory: string): ParsedProfile {
  const value = JSON.parse(text) as unknown;
  if (!isObject(value)) throw new Error("DSH Profile manifest must be an object");
  const dependencies = isObject(value.dependencies) ? value.dependencies : undefined;
  const dsh = isObject(value.dsh) ? value.dsh : undefined;
  const profile = dsh !== undefined && isObject(dsh.profile) ? dsh.profile : undefined;
  if (dependencies === undefined || profile === undefined || !Array.isArray(profile.bundles)) {
    throw new Error("DSH Profile manifest is incomplete");
  }
  const bundles = profile.bundles.filter((item): item is string => typeof item === "string");
  if (bundles.length !== profile.bundles.length) {
    throw new Error("DSH Profile bundles must contain only package names");
  }
  const candidates: ProfileCandidate[] = [];
  for (let index = 0; index < bundles.length; index += 1) {
    const packageName = bundles[index]!;
    const dependencySpec = dependencies[packageName];
    if (!isPackageName(packageName) || isProtectedPackage(packageName) || typeof dependencySpec !== "string") {
      continue;
    }
    const installedPath = path.join(profileDirectory, "node_modules", ...packageName.split("/"));
    const localPath = localDependencyPath(profileDirectory, dependencySpec);
    candidates.push({
      packageName,
      dependencySpec,
      originalBundleIndex: index,
      local: localPath !== undefined,
      matchValues: [packageName, installedPath, ...(localPath === undefined ? [] : [localPath])]
    });
  }
  return { value, bundles, candidates };
}

function parseReceipt(text: string): DesktopExtensionQuarantineReceipt {
  const value = JSON.parse(text) as unknown;
  if (!isObject(value)
    || value.schemaVersion !== 1
    || typeof value.quarantineId !== "string"
    || !/^[0-9a-f-]{36}$/.test(value.quarantineId)
    || (value.environment !== "prod" && value.environment !== "test")
    || !["pending", "active", "restored", "resolved"].includes(String(value.phase))
    || (value.mode !== "targeted" && value.mode !== "local-safe-mode")
    || !Number.isSafeInteger(value.createdAtMillis)
    || !Number.isSafeInteger(value.updatedAtMillis)
    || typeof value.failureSummary !== "string"
    || typeof value.failureLogTail !== "string"
    || !Array.isArray(value.entries)
    || value.entries.length === 0) {
    throw new Error("Desktop extension quarantine receipt is invalid");
  }
  const entries = value.entries.map((raw): DesktopExtensionQuarantineEntry => {
    if (!isObject(raw)
      || typeof raw.packageName !== "string"
      || !isPackageName(raw.packageName)
      || isProtectedPackage(raw.packageName)
      || typeof raw.dependencySpec !== "string"
      || !Number.isSafeInteger(raw.originalBundleIndex)
      || Number(raw.originalBundleIndex) < 0) {
      throw new Error("Desktop extension quarantine entry is invalid");
    }
    return {
      packageName: raw.packageName,
      dependencySpec: raw.dependencySpec,
      originalBundleIndex: Number(raw.originalBundleIndex),
      ...(Number.isSafeInteger(raw.synchronizedAtMillis)
        ? { synchronizedAtMillis: Number(raw.synchronizedAtMillis) }
        : {}),
      ...(Number.isSafeInteger(raw.notificationDismissedAtMillis)
        ? { notificationDismissedAtMillis: Number(raw.notificationDismissedAtMillis) }
        : {}),
      ...(Number.isSafeInteger(raw.reenableRequestedAtMillis)
        ? { reenableRequestedAtMillis: Number(raw.reenableRequestedAtMillis) }
        : {}),
      ...(Number.isSafeInteger(raw.resolvedAtMillis)
        ? { resolvedAtMillis: Number(raw.resolvedAtMillis) }
        : {})
    };
  });
  if (new Set(entries.map((entry) => entry.packageName)).size !== entries.length) {
    throw new Error("Desktop extension quarantine entries must be unique");
  }
  return {
    schemaVersion: 1,
    quarantineId: value.quarantineId,
    environment: value.environment,
    phase: value.phase as DesktopExtensionQuarantinePhase,
    mode: value.mode,
    createdAtMillis: Number(value.createdAtMillis),
    updatedAtMillis: Number(value.updatedAtMillis),
    ...(typeof value.runtimeReleaseId === "string" ? { runtimeReleaseId: value.runtimeReleaseId } : {}),
    failureSummary: value.failureSummary.slice(0, 2_000),
    failureLogTail: value.failureLogTail.slice(-MAX_FAILURE_TAIL_LENGTH),
    entries
  };
}

function setProfileBundles(value: Record<string, unknown>, bundles: string[]): void {
  const dsh = value.dsh as Record<string, unknown>;
  const profile = dsh.profile as Record<string, unknown>;
  profile.bundles = bundles;
}

function profileManifestPath(dshHome: string): string {
  return path.join(dshHome, "profiles", PROFILE_NAME, "package.json");
}

function quarantineDirectory(dshHome: string): string {
  return path.join(dshHome, "arkme-self", QUARANTINE_DIRECTORY_NAME);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPackageName(value: string): boolean {
  return PACKAGE_NAME_PATTERN.test(value);
}

function isProtectedPackage(packageName: string): boolean {
  return packageName === "@senguoyun/dsh-arkme" || packageName.startsWith("@deepseek-ai/");
}

function mentionsProtectedPackage(normalizedFailure: string): boolean {
  return normalizedFailure.includes("@senguoyun/dsh-arkme")
    || normalizedFailure.includes("@deepseek-ai/");
}

function localDependencyPath(profileDirectory: string, spec: string): string | undefined {
  if (!spec.startsWith("link:") && !spec.startsWith("file:")) return undefined;
  const raw = spec.slice(spec.indexOf(":") + 1).trim();
  if (raw === "") return undefined;
  return path.resolve(profileDirectory, raw);
}

function normalizedMatchText(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function sanitizedFailureTail(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(-MAX_FAILURE_TAIL_LENGTH);
}

function serializeReceipt(receipt: DesktopExtensionQuarantineReceipt): string {
  return `${JSON.stringify(receipt, undefined, 2)}\n`;
}

async function writeReceipt(
  receiptPath: string,
  receipt: DesktopExtensionQuarantineReceipt
): Promise<void> {
  await writeTextAtomically(receiptPath, serializeReceipt(receipt), 0o600);
}

async function writeSecureFile(filePath: string, text: string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeTextAtomically(filePath: string, text: string, mode: number): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    const handle = await open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
