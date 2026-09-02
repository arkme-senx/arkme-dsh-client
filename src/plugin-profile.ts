import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import semver from "semver";
import { isElectronRuntimeReleaseId } from "./runtime/manifest.js";
import type { RuntimeEnvironment } from "./runtime/service-config.js";

const PLUGIN_NAME = "@senguoyun/dsh-arkme";
const PACKAGE_MANAGER = "pnpm@11.19.0";
const WEB_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;
const TEST_PROFILE_PATCH = `- id: arkme-self
  config:
    environment: test
    authBaseUrl: https://jotmo.senguo.me
    subjectBaseUrl: https://jotmo-subject.senguo.me
    recordBaseUrl: https://jotmo-record.senguo.me
    dataBaseUrl: https://jotmo-data.senguo.me
    chatBaseUrl: https://jotmo-chat.senguo.me
    botBaseUrl: https://jotmo-bot.senguo.me
    imBaseUrl: https://jotmo-im.senguo.me
    webrtcBaseUrl: https://jotmo-webrtc.senguo.me
    worldBaseUrl: https://jotmo-world.senguo.me
    relationBaseUrl: https://jotmo-relation.senguo.me
    intelligentBaseUrl: https://jotmo-intelligent.senguo.me
    audioBaseUrl: https://jotmo-audio.senguo.me
    shareWebsite: https://jotmo-app.senguo.me
    extensionPublishBaseUrl: ''
    allowProduction: false
    updateCheckEnabled: false
    updateServiceBaseUrl: https://jotmo.senguo.me
    dshRemoteFeatureEnabled: true
    dshRemoteRealtimeBaseUrl: https://jotmo-realtime.senguo.me
`;
const PROFILE_WORKSPACE_TEMPLATE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;
const LEGACY_MIGRATION_BACKUP_PREFIX = "legacy-managed-link-";
const RUNTIME_PROFILE_TRANSACTION_FILE = ".arkme-runtime-profile-transaction.json";
const LEGACY_MIGRATION_RELATIVE_PATHS = [
  "pnpm-lock.yaml",
  path.join("node_modules", ".pnpm", "lock.yaml"),
  path.join("node_modules", ".modules.yaml")
];
const execFileAsync = promisify(execFile);

export interface ProfilePackageManager {
  executable: string;
  prefixArgs?: string[];
  installArgs?: string[];
  environment?: NodeJS.ProcessEnv;
}

export interface EmbeddedPluginArtifact {
  artifactPath: string;
  artifactSha512: string;
  packageName: "@senguoyun/dsh-arkme";
  version: string;
}

export interface ProvisionArkmeWebProfileOptions {
  dshHome: string;
  environment?: RuntimeEnvironment;
  pluginDir?: string;
  embeddedArtifact?: EmbeddedPluginArtifact;
  forceEmbedded?: boolean;
  appVersion?: string;
  dshVersion?: string;
  packageManager?: ProfilePackageManager;
  runtimeManaged?: boolean;
  runtimeReleaseId?: string;
}

export interface RuntimeManagedProfileTransaction {
  profileDir: string;
  environment: RuntimeEnvironment;
  releaseId: string;
  journalPath: string;
}

export interface ProvisionedArkmeProfile {
  profileDir: string;
  pluginDir: string;
  source: PluginSource;
  version: string;
  runtimeTransaction?: RuntimeManagedProfileTransaction;
}

type JsonObject = Record<string, unknown>;

type PluginSource = "embedded" | "independent" | "release-set";

interface PluginHealth {
  healthy: boolean;
  version?: string;
  sha512?: string;
  reason?: string;
}

interface PluginSelection {
  source: PluginSource;
  spec: string;
  version: string;
  sha512: string;
  health: PluginHealth;
}

interface EmbeddedPlugin {
  kind: "directory" | "artifact";
  path: string;
  spec: string;
  version: string;
  sha512: string;
  health: PluginHealth;
}

interface CompatibilityCheck {
  compatible: boolean;
  reason?: string;
}

interface LocalReceiptCheck extends CompatibilityCheck {
  managed: boolean;
}

type LegacyPluginLinkSource =
  | "installed-plugin-symlink"
  | "root-lockfile-link"
  | "virtual-store-lockfile-link";

interface LegacyPluginLinkState {
  sources: LegacyPluginLinkSource[];
  pluginLinkTarget?: string;
}

interface LockfilePluginResolution {
  specifier?: string;
  version?: string;
}

interface LegacyPluginLinkMigrationReceipt {
  schemaVersion: 1;
  reason: "legacy-managed-plugin-link";
  phase: "pending" | "completed";
  createdAtMillis: number;
  completedAtMillis?: number;
  detectedSources: LegacyPluginLinkSource[];
  pluginLinkTarget?: string;
  plannedPaths: string[];
  movedPaths: string[];
  missingPaths: string[];
}

interface RuntimeManagedProfileTransactionDocument {
  schemaVersion: 1;
  environment: RuntimeEnvironment;
  releaseId: string;
  phase: "prepared" | "previous-backed-up" | "linked" | "profile-written" | "committing";
  candidatePluginDir: string;
  previousManifest: string | null;
  backupEntryName: string;
  temporaryEntryName: string;
  createdAtMillis: number;
}

export async function provisionArkmeWebProfile(
  options: ProvisionArkmeWebProfileOptions
): Promise<ProvisionedArkmeProfile> {
  const embeddedPlugin = await resolveEmbeddedPlugin(options);

  const profileDir = path.join(options.dshHome, "profiles", "web");
  const installedPluginDir = path.join(
    profileDir,
    "node_modules",
    "@senguoyun",
    "dsh-arkme"
  );
  await mkdir(profileDir, { recursive: true });
  const manifestPath = path.join(profileDir, "package.json");
  const manifest = await readManifest(manifestPath) ?? {
    name: "dsh-profile-web",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...WEB_BUNDLES] } }
  };

  const dependencies = asObject(manifest.dependencies);
  const dsh = asObject(manifest.dsh);
  const profile = asObject(dsh.profile);
  const bundles = Array.isArray(profile.bundles)
    ? profile.bundles.filter((value): value is string => typeof value === "string")
    : [...WEB_BUNDLES];
  if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME);

  const selection = await selectPluginForProfile(
    profileDir,
    options.runtimeManaged === true ? { ...manifest, dependencies: {} } : manifest,
    embeddedPlugin,
    {
      ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
      ...(options.dshVersion === undefined ? {} : { dshVersion: options.dshVersion })
    },
    options.forceEmbedded === true || options.runtimeManaged === true
  );
  if (options.runtimeManaged === true) selection.source = "release-set";
  const arkme = asObject(manifest.arkme);
  const updatedManifest: JsonObject = {
    ...manifest,
    packageManager: PACKAGE_MANAGER,
    dependencies: {
      ...dependencies,
      [PLUGIN_NAME]: selection.spec
    },
    arkme: {
      ...arkme,
      desktopManaged: options.runtimeManaged === true,
      managedPlugin: {
        source: selection.source,
        version: selection.version,
        sha512: selection.sha512,
        lastHealthCheck: {
          healthy: selection.health.healthy,
          checkedAtMillis: Date.now(),
          ...(selection.health.reason === undefined ? {} : { reason: selection.health.reason })
        }
      }
    },
    dsh: {
      ...dsh,
      profile: {
        ...profile,
        bundles
      }
    }
  };
  const profilePatchPath = path.join(profileDir, "cordis.patch.yml");
  if (options.environment === "test") {
    await writeTextAtomically(profilePatchPath, TEST_PROFILE_PATCH);
  } else {
    await writeIfMissing(profilePatchPath, PROFILE_PATCH_TEMPLATE);
  }
  await writeIfMissing(
    path.join(profileDir, "pnpm-workspace.yaml"),
    PROFILE_WORKSPACE_TEMPLATE
  );
  const expectedPluginSpecifier = selection.spec;
  const embeddedInstallationAligned = embeddedPlugin.kind === "directory"
    ? await managedPluginLinkMatches(profileDir, embeddedPlugin.path)
    : await physicalPluginMatches(installedPluginDir, embeddedPlugin.version);
  const profileIsAligned = dependencies[PLUGIN_NAME] === expectedPluginSpecifier
    && manifest.packageManager === PACKAGE_MANAGER
    && (selection.source !== "independent"
      ? embeddedInstallationAligned
      : selection.health.healthy)
    && await lockfilePluginSpecifierMatches(profileDir, expectedPluginSpecifier);
  let runtimeTransaction: RuntimeManagedProfileTransaction | undefined;
  if (options.runtimeManaged === true) {
    if (embeddedPlugin.kind !== "directory") {
      throw new Error("A Release Set must expose the Arkme plugin as an installed directory");
    }
    const releaseId = options.runtimeReleaseId;
    if (releaseId === undefined || !isElectronRuntimeReleaseId(releaseId)) {
      throw new Error("A valid runtime Release ID is required for a managed Profile transaction");
    }
    const environment = options.environment ?? "prod";
    await recoverRuntimeManagedProfileTransaction(options.dshHome, environment);
    const runtimeProfileIsAligned = dependencies[PLUGIN_NAME] === expectedPluginSpecifier
      && manifest.packageManager === PACKAGE_MANAGER
      && embeddedInstallationAligned;
    if (runtimeProfileIsAligned) {
      await writeManifestAtomically(manifestPath, updatedManifest);
    } else {
      runtimeTransaction = await beginRuntimeManagedProfileTransaction({
        profileDir,
        environment,
        releaseId,
        candidatePluginDir: embeddedPlugin.path,
        nextManifest: updatedManifest
      });
    }
  } else {
    await writeManifestAtomically(manifestPath, updatedManifest);
  }
  if (selection.source !== "independent" && options.runtimeManaged !== true) {
    if (embeddedPlugin.kind === "artifact") {
      if (options.packageManager === undefined) {
        throw new Error("A package manager is required to install the embedded Arkme plugin artifact");
      }
      const resumedLegacyMigration = await resumePendingLegacyPluginLinkMigrations(profileDir);
      const legacyPluginLinkState: LegacyPluginLinkState = resumedLegacyMigration
        ? { sources: [] }
        : await inspectLegacyPluginLinkState(profileDir, installedPluginDir);
      if (
        !profileIsAligned
        || resumedLegacyMigration
        || legacyPluginLinkState.sources.length > 0
      ) {
        if (legacyPluginLinkState.sources.length > 0) {
          await quarantineLegacyPluginLinkMetadata(profileDir, legacyPluginLinkState);
        }
        await removeManagedPluginEntry(installedPluginDir);
        await synchronizeProfileDependencies(profileDir, options.packageManager);
      }
      await assertPhysicalPluginMaterialized(installedPluginDir, embeddedPlugin.version);
    } else {
      await migratePluginLinkIfNeeded(profileDir);
      if (options.packageManager !== undefined && !profileIsAligned) {
        await synchronizeProfileDependencies(profileDir, options.packageManager);
        await assertPluginMaterialized(profileDir, embeddedPlugin.path);
      } else {
        await ensurePluginSymlink(profileDir, embeddedPlugin.path);
      }
    }
  }

  const finalHealth = await inspectPluginDirectory(installedPluginDir);
  if (
    !finalHealth.healthy ||
    finalHealth.version !== selection.version ||
    finalHealth.sha512 === undefined
  ) {
    if (runtimeTransaction !== undefined) {
      await rollbackRuntimeManagedProfileTransaction(runtimeTransaction).catch(() => undefined);
    }
    throw new Error(`Arkme plugin installation is unhealthy at ${installedPluginDir}`);
  }
  const finalManifest = {
    ...updatedManifest,
    arkme: {
      ...asObject(updatedManifest.arkme),
      managedPlugin: {
        source: selection.source,
        version: finalHealth.version,
        sha512: finalHealth.sha512,
        lastHealthCheck: {
          healthy: true,
          checkedAtMillis: Date.now(),
          ...(selection.health.reason === undefined
            ? {}
            : { reason: selection.health.reason })
        }
      }
    }
  };
  await writeManifestAtomically(manifestPath, finalManifest);
  return {
    profileDir,
    pluginDir: installedPluginDir,
    source: selection.source,
    version: finalHealth.version,
    ...(runtimeTransaction === undefined ? {} : { runtimeTransaction })
  };
}

async function beginRuntimeManagedProfileTransaction(input: {
  profileDir: string;
  environment: RuntimeEnvironment;
  releaseId: string;
  candidatePluginDir: string;
  nextManifest: JsonObject;
}): Promise<RuntimeManagedProfileTransaction> {
  const journalPath = path.join(input.profileDir, RUNTIME_PROFILE_TRANSACTION_FILE);
  const manifestPath = path.join(input.profileDir, "package.json");
  const entryDirectory = path.join(input.profileDir, "node_modules", "@senguoyun");
  const linkPath = path.join(entryDirectory, "dsh-arkme");
  const transactionId = randomUUID();
  const backupEntryName = `.dsh-arkme.runtime-previous-${transactionId}`;
  const temporaryEntryName = `.dsh-arkme.runtime-candidate-${transactionId}`;
  const transaction: RuntimeManagedProfileTransaction = {
    profileDir: input.profileDir,
    environment: input.environment,
    releaseId: input.releaseId,
    journalPath
  };
  const document: RuntimeManagedProfileTransactionDocument = {
    schemaVersion: 1,
    environment: input.environment,
    releaseId: input.releaseId,
    phase: "prepared",
    candidatePluginDir: path.resolve(input.candidatePluginDir),
    previousManifest: await readOptionalText(manifestPath),
    backupEntryName,
    temporaryEntryName,
    createdAtMillis: Date.now()
  };
  await mkdir(entryDirectory, { recursive: true });
  await writeRuntimeProfileTransactionDocument(journalPath, document);
  try {
    const temporaryEntryPath = path.join(entryDirectory, temporaryEntryName);
    const backupEntryPath = path.join(entryDirectory, backupEntryName);
    await symlink(document.candidatePluginDir, temporaryEntryPath, "junction");
    if (await pathEntryExists(linkPath)) {
      await rename(linkPath, backupEntryPath);
    }
    document.phase = "previous-backed-up";
    await writeRuntimeProfileTransactionDocument(journalPath, document);
    await rename(temporaryEntryPath, linkPath);
    document.phase = "linked";
    await writeRuntimeProfileTransactionDocument(journalPath, document);
    await writeManifestAtomically(manifestPath, input.nextManifest);
    document.phase = "profile-written";
    await writeRuntimeProfileTransactionDocument(journalPath, document);
    return transaction;
  } catch (error) {
    await rollbackRuntimeManagedProfileTransaction(transaction).catch(() => undefined);
    throw error;
  }
}

export async function commitRuntimeManagedProfileTransaction(
  transaction: RuntimeManagedProfileTransaction
): Promise<void> {
  const document = await readRuntimeProfileTransactionDocument(transaction);
  await assertRuntimeProfileCandidateLinked(transaction.profileDir, document.candidatePluginDir);
  document.phase = "committing";
  await writeRuntimeProfileTransactionDocument(transaction.journalPath, document);
  await finishRuntimeManagedProfileCommit(transaction, document);
}

async function finishRuntimeManagedProfileCommit(
  transaction: RuntimeManagedProfileTransaction,
  document: RuntimeManagedProfileTransactionDocument
): Promise<void> {
  await assertRuntimeProfileCandidateLinked(transaction.profileDir, document.candidatePluginDir);
  const entryDirectory = path.join(transaction.profileDir, "node_modules", "@senguoyun");
  try {
    await rm(path.join(entryDirectory, document.backupEntryName), { recursive: true, force: true });
    await rm(path.join(entryDirectory, document.temporaryEntryName), { recursive: true, force: true });
    await rm(transaction.journalPath, { force: true });
  } catch {
    // The committing journal is the durable commit point. Cleanup is retried on the next launch.
  }
}

export async function rollbackRuntimeManagedProfileTransaction(
  transaction: RuntimeManagedProfileTransaction
): Promise<void> {
  const document = await readRuntimeProfileTransactionDocument(transaction);
  if (document.phase === "committing") {
    await finishRuntimeManagedProfileCommit(transaction, document);
    return;
  }
  const manifestPath = path.join(transaction.profileDir, "package.json");
  const entryDirectory = path.join(transaction.profileDir, "node_modules", "@senguoyun");
  const linkPath = path.join(entryDirectory, "dsh-arkme");
  const backupEntryPath = path.join(entryDirectory, document.backupEntryName);
  const temporaryEntryPath = path.join(entryDirectory, document.temporaryEntryName);
  const backupExists = await pathEntryExists(backupEntryPath);
  try {
    const linkStat = await lstat(linkPath);
    if (!linkStat.isSymbolicLink()) {
      if (backupExists) {
        throw new Error("Runtime-managed Profile rollback refused to replace a non-link plugin entry");
      }
    } else {
      const [actualTarget, candidateTarget] = await Promise.all([
        realpath(linkPath).catch(() => null),
        realpath(document.candidatePluginDir).catch(() => null)
      ]);
      if (actualTarget !== null && candidateTarget !== null && actualTarget === candidateTarget) {
        await unlink(linkPath);
      } else if (backupExists) {
        throw new Error("Runtime-managed Profile rollback found an unexpected plugin link target");
      }
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  if (backupExists) {
    await rename(backupEntryPath, linkPath);
  }
  if (document.previousManifest === null) {
    await rm(manifestPath, { force: true });
  } else {
    await writeTextAtomically(manifestPath, document.previousManifest);
  }
  await rm(temporaryEntryPath, { recursive: true, force: true });
  await rm(transaction.journalPath, { force: true });
}

export async function recoverRuntimeManagedProfileTransaction(
  dshHome: string,
  environment: RuntimeEnvironment
): Promise<boolean> {
  const profileDir = path.join(dshHome, "profiles", "web");
  const journalPath = path.join(profileDir, RUNTIME_PROFILE_TRANSACTION_FILE);
  let raw: string;
  try {
    raw = await readFile(journalPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  const parsed = parseRuntimeProfileTransactionDocument(JSON.parse(raw) as unknown);
  if (parsed.environment !== environment) {
    throw new Error(
      `Runtime-managed Profile transaction environment mismatch: expected ${environment}, received ${parsed.environment}`
    );
  }
  const transaction = {
    profileDir,
    environment,
    releaseId: parsed.releaseId,
    journalPath
  };
  if (parsed.phase === "committing") {
    await finishRuntimeManagedProfileCommit(transaction, parsed);
    return true;
  }
  await rollbackRuntimeManagedProfileTransaction({
    ...transaction
  });
  return true;
}

async function readRuntimeProfileTransactionDocument(
  transaction: RuntimeManagedProfileTransaction
): Promise<RuntimeManagedProfileTransactionDocument> {
  const expectedJournalPath = path.join(transaction.profileDir, RUNTIME_PROFILE_TRANSACTION_FILE);
  if (path.resolve(transaction.journalPath) !== path.resolve(expectedJournalPath)) {
    throw new Error("Runtime-managed Profile transaction journal path is invalid");
  }
  const document = parseRuntimeProfileTransactionDocument(
    JSON.parse(await readFile(expectedJournalPath, "utf8")) as unknown
  );
  if (
    document.environment !== transaction.environment
    || document.releaseId !== transaction.releaseId
  ) {
    throw new Error("Runtime-managed Profile transaction identity mismatch");
  }
  return document;
}

function parseRuntimeProfileTransactionDocument(
  value: unknown
): RuntimeManagedProfileTransactionDocument {
  const document = asObject(value);
  const phases = new Set(["prepared", "previous-backed-up", "linked", "profile-written", "committing"]);
  if (
    document.schemaVersion !== 1
    || (document.environment !== "prod" && document.environment !== "test")
    || typeof document.releaseId !== "string"
    || !isElectronRuntimeReleaseId(document.releaseId)
    || typeof document.phase !== "string"
    || !phases.has(document.phase)
    || typeof document.candidatePluginDir !== "string"
    || !path.isAbsolute(document.candidatePluginDir)
    || (document.previousManifest !== null && typeof document.previousManifest !== "string")
    || typeof document.backupEntryName !== "string"
    || !/^\.dsh-arkme\.runtime-previous-[0-9a-f-]+$/.test(document.backupEntryName)
    || typeof document.temporaryEntryName !== "string"
    || !/^\.dsh-arkme\.runtime-candidate-[0-9a-f-]+$/.test(document.temporaryEntryName)
    || typeof document.createdAtMillis !== "number"
    || !Number.isFinite(document.createdAtMillis)
  ) {
    throw new Error("Runtime-managed Profile transaction is invalid");
  }
  return document as unknown as RuntimeManagedProfileTransactionDocument;
}

async function assertRuntimeProfileCandidateLinked(
  profileDir: string,
  candidatePluginDir: string
): Promise<void> {
  const linkPath = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
  let linkStat;
  try {
    linkStat = await lstat(linkPath);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error("Runtime-managed Profile commit is missing the candidate plugin link", { cause: error });
    }
    throw error;
  }
  if (!linkStat.isSymbolicLink()) {
    throw new Error("Runtime-managed Profile commit refused a non-link plugin entry");
  }
  const [actualTarget, candidateTarget] = await Promise.all([
    realpath(linkPath),
    realpath(candidatePluginDir)
  ]);
  if (actualTarget !== candidateTarget) {
    throw new Error("Runtime-managed Profile commit found an unexpected plugin link target");
  }
}

async function writeRuntimeProfileTransactionDocument(
  journalPath: string,
  document: RuntimeManagedProfileTransactionDocument
): Promise<void> {
  await writeJsonAtomically(journalPath, document as unknown as JsonObject);
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function selectPluginForProfile(
  profileDir: string,
  manifest: JsonObject,
  embeddedPlugin: EmbeddedPlugin,
  currentVersions: { appVersion?: string; dshVersion?: string },
  forceEmbedded: boolean
): Promise<PluginSelection> {
  const dependencies = asObject(manifest.dependencies);
  const currentSpec = typeof dependencies[PLUGIN_NAME] === "string"
    ? dependencies[PLUGIN_NAME]
    : undefined;
  const installedDir = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
  const installedHealth = await inspectPluginDirectory(installedDir);
  const hasIndependentLocalSpec = currentSpec !== undefined
    && currentSpec !== embeddedPlugin.spec
    && isLocalPluginSpecifier(currentSpec);
  let independentFallbackReason = installedHealth.reason;

  if (
    !forceEmbedded &&
    hasIndependentLocalSpec &&
    installedHealth.healthy &&
    installedHealth.version !== undefined &&
    installedHealth.sha512 !== undefined &&
    semver.compare(installedHealth.version, embeddedPlugin.version) >= 0
  ) {
    const compatibility = await inspectIndependentPluginCompatibility(
      currentSpec,
      profileDir,
      installedHealth.version,
      currentVersions
    );
    if (!compatibility.compatible) {
      independentFallbackReason = compatibility.reason;
    } else {
      return {
        source: "independent",
        spec: currentSpec,
        version: installedHealth.version,
        sha512: installedHealth.sha512,
        health: installedHealth
      };
    }
  } else if (hasIndependentLocalSpec && installedHealth.healthy) {
    independentFallbackReason = "independent plugin older than embedded plugin";
  }

  return {
    source: "embedded",
    spec: embeddedPlugin.spec,
    version: embeddedPlugin.version,
    sha512: embeddedPlugin.sha512,
    health: {
      healthy: true,
      version: embeddedPlugin.version,
      sha512: embeddedPlugin.sha512,
      ...(independentFallbackReason === undefined
        ? {}
        : { reason: independentFallbackReason })
    }
  };
}

async function resolveEmbeddedPlugin(
  options: ProvisionArkmeWebProfileOptions
): Promise<EmbeddedPlugin> {
  if ((options.pluginDir === undefined) === (options.embeddedArtifact === undefined)) {
    throw new Error("Exactly one embedded Arkme plugin directory or artifact is required");
  }
  if (options.embeddedArtifact !== undefined) {
    const artifactPath = path.resolve(options.embeddedArtifact.artifactPath);
    if (
      options.embeddedArtifact.packageName !== PLUGIN_NAME ||
      !isSemver(options.embeddedArtifact.version) ||
      !/^[a-f0-9]{128}$/.test(options.embeddedArtifact.artifactSha512)
    ) {
      throw new Error(`Invalid embedded Arkme plugin artifact metadata at ${artifactPath}`);
    }
    let artifactSha512: string;
    try {
      artifactSha512 = createHash("sha512")
        .update(await readFile(artifactPath))
        .digest("hex");
    } catch (cause) {
      throw new Error(`Embedded Arkme plugin artifact is unavailable at ${artifactPath}`, { cause });
    }
    if (artifactSha512 !== options.embeddedArtifact.artifactSha512) {
      throw new Error(`Embedded Arkme plugin artifact digest mismatch at ${artifactPath}`);
    }
    return {
      kind: "artifact",
      path: artifactPath,
      spec: `file:${artifactPath}`,
      version: options.embeddedArtifact.version,
      sha512: artifactSha512,
      health: {
        healthy: true,
        version: options.embeddedArtifact.version,
        sha512: artifactSha512
      }
    };
  }

  const pluginDir = path.resolve(options.pluginDir!);
  const embeddedManifest = await validatePlugin(pluginDir);
  const embeddedVersion = stringValue(embeddedManifest.version);
  const embeddedHealth = await inspectPluginDirectory(pluginDir);
  if (
    embeddedVersion === undefined ||
    !isSemver(embeddedVersion) ||
    !embeddedHealth.healthy ||
    embeddedHealth.version === undefined ||
    embeddedHealth.sha512 === undefined
  ) {
    throw new Error(`Invalid embedded Arkme plugin at ${pluginDir}`);
  }
  return {
    kind: "directory",
    path: pluginDir,
    spec: `link:${pluginDir}`,
    version: embeddedHealth.version,
    sha512: embeddedHealth.sha512,
    health: embeddedHealth
  };
}

function isLocalPluginSpecifier(spec: string): boolean {
  return spec.startsWith("file:");
}

function artifactPathFromLocalFileSpecifier(spec: string): string | undefined {
  if (!spec.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(new URL(spec));
  } catch {
    const rawPath = spec.slice("file:".length);
    return path.isAbsolute(rawPath) ? rawPath : undefined;
  }
}

async function inspectIndependentPluginCompatibility(
  spec: string,
  profileDir: string,
  installedVersion: string,
  currentVersions: { appVersion?: string; dshVersion?: string }
): Promise<CompatibilityCheck> {
  const artifactPath = artifactPathFromLocalFileSpecifier(spec);
  if (artifactPath === undefined) {
    return { compatible: false, reason: "independent plugin is not a cached file artifact" };
  }
  const receipt = await inspectLocalInstallReceipt(
    artifactPath,
    profileDir,
    installedVersion,
    currentVersions
  );
  if (receipt.compatible) return receipt;
  if (receipt.managed) return receipt;
  return await inspectReleaseManifestCompatibility(artifactPath, currentVersions);
}

async function inspectLocalInstallReceipt(
  artifactPath: string,
  profileDir: string,
  installedVersion: string,
  currentVersions: { appVersion?: string; dshVersion?: string }
): Promise<LocalReceiptCheck> {
  const dshHome = path.resolve(profileDir, "..", "..");
  const managedRoot = path.join(dshHome, "arkme-self");
  const relativeArtifactPath = path.relative(managedRoot, path.resolve(artifactPath));
  if (
    relativeArtifactPath === ".." ||
    relativeArtifactPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeArtifactPath)
  ) {
    return { compatible: false, managed: false, reason: "independent plugin is outside managed plugin cache" };
  }
  const parts = relativeArtifactPath.split(path.sep);
  if (
    parts.length !== 4 ||
    !["prod", "test"].includes(parts[0] ?? "") ||
    parts[1] !== "plugin-cache" ||
    parts[2] !== installedVersion ||
    parts[3] !== `dsh-arkme-${installedVersion}.tgz`
  ) {
    return { compatible: false, managed: true, reason: "independent plugin is outside managed plugin cache" };
  }
  const receiptPath = path.join(path.dirname(artifactPath), "plugin-update-install-receipt.json");
  let receipt: JsonObject;
  try {
    receipt = asObject(JSON.parse(await readFile(receiptPath, "utf8")) as unknown);
  } catch (error) {
    return {
      compatible: false,
      managed: true,
      reason: isMissingFile(error) ? "local install receipt missing" : "local install receipt is invalid"
    };
  }
  const receiptArtifactPath = stringValue(receipt.targetArtifactPath);
  const receiptSha512 = stringValue(receipt.targetArtifactSha512);
  const receiptAppVersion = stringValue(receipt.appVersion);
  const receiptDshVersion = stringValue(receipt.dshVersion);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.packageName !== PLUGIN_NAME ||
    receipt.targetVersion !== installedVersion ||
    receiptArtifactPath === undefined ||
    !path.isAbsolute(receiptArtifactPath) ||
    path.resolve(receiptArtifactPath) !== path.resolve(artifactPath) ||
    receiptSha512 === undefined ||
    !/^[a-f0-9]{128}$/.test(receiptSha512) ||
    receiptAppVersion === undefined ||
    receiptDshVersion === undefined ||
    typeof receipt.installedAtMillis !== "number" ||
    !Number.isFinite(receipt.installedAtMillis) ||
    receipt.installedAtMillis <= 0
  ) {
    return { compatible: false, managed: true, reason: "local install receipt is invalid" };
  }
  if (
    currentVersions.appVersion !== receiptAppVersion ||
    currentVersions.dshVersion !== receiptDshVersion
  ) {
    return {
      compatible: false,
      managed: true,
      reason: "local install receipt does not match current app or DSH"
    };
  }
  try {
    const artifactSha512 = createHash("sha512").update(await readFile(artifactPath)).digest("hex");
    if (artifactSha512 !== receiptSha512) {
      return {
        compatible: false,
        managed: true,
        reason: "local install receipt artifact digest mismatch"
      };
    }
  } catch {
    return { compatible: false, managed: true, reason: "local install receipt artifact unavailable" };
  }
  return { compatible: true, managed: true };
}

async function inspectReleaseManifestCompatibility(
  artifactPath: string,
  currentVersions: { appVersion?: string; dshVersion?: string }
): Promise<CompatibilityCheck> {
  let manifest: JsonObject;
  try {
    const parsed = JSON.parse(
      await readFile(path.join(path.dirname(artifactPath), "release-manifest.json"), "utf8")
    ) as unknown;
    manifest = asObject(parsed);
  } catch (error) {
    return {
      compatible: false,
      reason: isMissingFile(error)
        ? "independent plugin compatibility manifest missing"
        : "independent plugin compatibility manifest invalid"
    };
  }
  const appVersionRange = stringValue(manifest.appVersionRange);
  const dshVersionRange = stringValue(manifest.dshVersionRange);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.packageName !== PLUGIN_NAME ||
    appVersionRange === undefined ||
    dshVersionRange === undefined
  ) {
    return { compatible: false, reason: "independent plugin compatibility manifest invalid" };
  }
  if (!versionSatisfies(currentVersions.appVersion, appVersionRange)
    || !versionSatisfies(currentVersions.dshVersion, dshVersionRange)) {
    return { compatible: false, reason: "independent plugin incompatible with current app or DSH" };
  }
  return { compatible: true };
}

function versionSatisfies(version: string | undefined, range: string): boolean {
  const normalizedVersion = stringValue(version);
  if (normalizedVersion === undefined || semver.valid(normalizedVersion) === null) return false;
  if (semver.validRange(range) === null) return false;
  return semver.satisfies(normalizedVersion, range, { includePrerelease: true });
}

async function inspectPluginDirectory(pluginDir: string): Promise<PluginHealth> {
  try {
    const packageJsonPath = path.join(pluginDir, "package.json");
    const packageJson = await readFile(packageJsonPath);
    const manifest = JSON.parse(packageJson.toString("utf8")) as JsonObject;
    const version = stringValue(manifest.version);
    const dsh = asObject(manifest.dsh);
    const bundle = asObject(dsh.bundle);
    if (manifest.name !== PLUGIN_NAME || version === undefined || !isSemver(version)
      || bundle.patch !== "./cordis.patch.yml") {
      return { healthy: false, reason: "package metadata invalid" };
    }
    const patch = await readFile(path.join(pluginDir, "cordis.patch.yml"));
    const hostEntry = await readFile(path.join(pluginDir, "lib", "index.js"));
    const clientEntry = await readFile(path.join(pluginDir, "lib", "client.js"));
    const hash = createHash("sha512");
    for (const bytes of [packageJson, patch, hostEntry, clientEntry]) {
      hash.update(bytes);
      hash.update("\0");
    }
    return { healthy: true, version, sha512: hash.digest("hex") };
  } catch (error) {
    return {
      healthy: false,
      reason: isMissingFile(error)
        ? "required file missing"
        : error instanceof Error ? error.message : String(error)
    };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

async function managedPluginLinkMatches(
  profileDir: string,
  pluginDir: string
): Promise<boolean> {
  const linkPath = path.join(profileDir, "node_modules", "@senguoyun", "dsh-arkme");
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    return path.resolve(path.dirname(linkPath), await readlink(linkPath)) === path.resolve(pluginDir);
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function lockfilePluginSpecifierMatches(
  profileDir: string,
  expectedSpecifier: string
): Promise<boolean> {
  const resolution = await readLockfilePluginResolution(
    path.join(profileDir, "pnpm-lock.yaml")
  );
  return resolution?.specifier === expectedSpecifier;
}

async function readLockfilePluginResolution(
  lockfilePath: string
): Promise<LockfilePluginResolution | undefined> {
  let contents: string;
  try {
    contents = await readFile(lockfilePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  const lines = contents.split(/\r?\n/);
  const importersLine = lines.findIndex((line) => /^importers:\s*$/.test(line));
  if (importersLine === -1) return undefined;
  let rootImporterLine = -1;
  for (let index = importersLine + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ")) break;
    if (/^ {2}(?:\.|'\.'|"\."):\s*$/.test(line)) {
      rootImporterLine = index;
      break;
    }
  }
  if (rootImporterLine === -1) return undefined;
  for (let index = rootImporterLine + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith("    ")) break;
    if (!/^ {4}(?:dependencies|optionalDependencies|devDependencies):\s*$/.test(line)) {
      continue;
    }
    for (index += 1; index < lines.length; index += 1) {
      const dependencyLine = lines[index] ?? "";
      if (dependencyLine.trim() === "" || dependencyLine.trimStart().startsWith("#")) {
        continue;
      }
      if (!dependencyLine.startsWith("      ")) {
        index -= 1;
        break;
      }
      if (!/^ {6}(?:@senguoyun\/dsh-arkme|'@senguoyun\/dsh-arkme'|"@senguoyun\/dsh-arkme"):\s*$/.test(dependencyLine)) {
        continue;
      }
      const resolution: LockfilePluginResolution = {};
      for (index += 1; index < lines.length; index += 1) {
        const fieldLine = lines[index] ?? "";
        if (fieldLine.trim() === "" || fieldLine.trimStart().startsWith("#")) continue;
        if (!fieldLine.startsWith("        ")) {
          index -= 1;
          break;
        }
        const match = /^ {8}(specifier|version):\s*(.+?)\s*$/.exec(fieldLine);
        if (match === null) continue;
        const value = parseLockfileScalar(match[2] ?? "");
        if (match[1] === "specifier") resolution.specifier = value;
        if (match[1] === "version") resolution.version = value;
      }
      return resolution;
    }
  }
  return undefined;
}

async function inspectLegacyPluginLinkState(
  profileDir: string,
  installedPluginDir: string
): Promise<LegacyPluginLinkState> {
  const sources: LegacyPluginLinkSource[] = [];
  let pluginLinkTarget: string | undefined;
  try {
    const stat = await lstat(installedPluginDir);
    if (stat.isSymbolicLink()) {
      sources.push("installed-plugin-symlink");
      pluginLinkTarget = path.resolve(
        path.dirname(installedPluginDir),
        await readlink(installedPluginDir)
      );
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const rootResolution = await readLockfilePluginResolution(
    path.join(profileDir, "pnpm-lock.yaml")
  );
  if (lockfileResolutionUsesLink(rootResolution)) {
    sources.push("root-lockfile-link");
  }
  const virtualStoreResolution = await readLockfilePluginResolution(
    path.join(profileDir, "node_modules", ".pnpm", "lock.yaml")
  );
  if (lockfileResolutionUsesLink(virtualStoreResolution)) {
    sources.push("virtual-store-lockfile-link");
  }
  return {
    sources,
    ...(pluginLinkTarget === undefined ? {} : { pluginLinkTarget })
  };
}

function lockfileResolutionUsesLink(
  resolution: LockfilePluginResolution | undefined
): boolean {
  return resolution?.specifier?.startsWith("link:") === true
    || resolution?.version?.startsWith("link:") === true;
}

async function quarantineLegacyPluginLinkMetadata(
  profileDir: string,
  state: LegacyPluginLinkState
): Promise<void> {
  const backupRoot = path.join(profileDir, ".arkme-migration-backups");
  const migrationId = `${Date.now()}-${randomUUID()}`;
  const backupDir = path.join(
    backupRoot,
    `${LEGACY_MIGRATION_BACKUP_PREFIX}${migrationId}`
  );
  const preparingDir = path.join(backupRoot, `.preparing-${migrationId}`);
  const receipt: LegacyPluginLinkMigrationReceipt = {
    schemaVersion: 1,
    reason: "legacy-managed-plugin-link",
    phase: "pending",
    createdAtMillis: Date.now(),
    detectedSources: state.sources,
    ...(state.pluginLinkTarget === undefined
      ? {}
      : { pluginLinkTarget: state.pluginLinkTarget }),
    plannedPaths: [...LEGACY_MIGRATION_RELATIVE_PATHS],
    movedPaths: [],
    missingPaths: []
  };
  await mkdir(preparingDir, { recursive: true });
  try {
    await writeMigrationReceiptAtomically(preparingDir, receipt);
    await rename(preparingDir, backupDir);
  } finally {
    await rm(preparingDir, { recursive: true, force: true });
  }
  await continueLegacyPluginLinkMetadataQuarantine(profileDir, backupDir, receipt);
}

async function resumePendingLegacyPluginLinkMigrations(
  profileDir: string
): Promise<boolean> {
  const backupRoot = path.join(profileDir, ".arkme-migration-backups");
  let backupNames: string[];
  try {
    backupNames = (await readdir(backupRoot)).sort();
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  let resumed = false;
  for (const backupName of backupNames) {
    if (!backupName.startsWith(LEGACY_MIGRATION_BACKUP_PREFIX)) continue;
    const backupDir = path.join(backupRoot, backupName);
    const receipt = await readLegacyPluginLinkMigrationReceipt(backupDir);
    if (receipt.phase === "completed") continue;
    resumed = true;
    await continueLegacyPluginLinkMetadataQuarantine(profileDir, backupDir, receipt);
  }
  return resumed;
}

async function readLegacyPluginLinkMigrationReceipt(
  backupDir: string
): Promise<LegacyPluginLinkMigrationReceipt> {
  const receiptPath = path.join(backupDir, "migration.json");
  let receipt: JsonObject;
  try {
    receipt = asObject(JSON.parse(await readFile(receiptPath, "utf8")) as unknown);
  } catch (error) {
    throw new Error(`Invalid legacy Arkme plugin migration receipt at ${receiptPath}`, {
      cause: error
    });
  }
  const phase = receipt.phase;
  const detectedSources = stringArray(receipt.detectedSources);
  const plannedPaths = stringArray(receipt.plannedPaths);
  const movedPaths = stringArray(receipt.movedPaths);
  const missingPaths = receipt.missingPaths === undefined
    ? []
    : stringArray(receipt.missingPaths);
  const validSources = new Set<LegacyPluginLinkSource>([
    "installed-plugin-symlink",
    "root-lockfile-link",
    "virtual-store-lockfile-link"
  ]);
  if (
    receipt.schemaVersion !== 1
    || receipt.reason !== "legacy-managed-plugin-link"
    || (phase !== "pending" && phase !== "completed")
    || typeof receipt.createdAtMillis !== "number"
    || !Number.isFinite(receipt.createdAtMillis)
    || detectedSources === undefined
    || !detectedSources.every((source) => validSources.has(source as LegacyPluginLinkSource))
    || plannedPaths === undefined
    || !sameStringArray(plannedPaths, LEGACY_MIGRATION_RELATIVE_PATHS)
    || movedPaths === undefined
    || !movedPaths.every((relativePath) => LEGACY_MIGRATION_RELATIVE_PATHS.includes(relativePath))
    || missingPaths === undefined
    || !missingPaths.every((relativePath) => LEGACY_MIGRATION_RELATIVE_PATHS.includes(relativePath))
  ) {
    throw new Error(`Invalid legacy Arkme plugin migration receipt at ${receiptPath}`);
  }
  const pluginLinkTarget = stringValue(receipt.pluginLinkTarget);
  return {
    schemaVersion: 1,
    reason: "legacy-managed-plugin-link",
    phase,
    createdAtMillis: receipt.createdAtMillis,
    ...(typeof receipt.completedAtMillis === "number"
      ? { completedAtMillis: receipt.completedAtMillis }
      : {}),
    detectedSources: detectedSources as LegacyPluginLinkSource[],
    ...(pluginLinkTarget === undefined ? {} : { pluginLinkTarget }),
    plannedPaths,
    movedPaths,
    missingPaths
  };
}

async function continueLegacyPluginLinkMetadataQuarantine(
  profileDir: string,
  backupDir: string,
  receipt: LegacyPluginLinkMigrationReceipt
): Promise<void> {
  const movedPaths = new Set(receipt.movedPaths);
  const missingPaths = new Set(receipt.missingPaths);
  for (const relativePath of LEGACY_MIGRATION_RELATIVE_PATHS) {
    const sourcePath = path.join(profileDir, relativePath);
    const destinationPath = path.join(backupDir, relativePath);
    if (await pathEntryExists(destinationPath)) {
      movedPaths.add(relativePath);
      missingPaths.delete(relativePath);
    } else if (await pathEntryExists(sourcePath)) {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await rename(sourcePath, destinationPath);
      movedPaths.add(relativePath);
      missingPaths.delete(relativePath);
    } else {
      missingPaths.add(relativePath);
    }
    receipt.movedPaths = LEGACY_MIGRATION_RELATIVE_PATHS.filter((relativePath) =>
      movedPaths.has(relativePath)
    );
    receipt.missingPaths = LEGACY_MIGRATION_RELATIVE_PATHS.filter((relativePath) =>
      missingPaths.has(relativePath)
    );
    await writeMigrationReceiptAtomically(backupDir, receipt);
  }
  receipt.phase = "completed";
  receipt.completedAtMillis = Date.now();
  await writeMigrationReceiptAtomically(backupDir, receipt);
}

async function writeMigrationReceiptAtomically(
  backupDir: string,
  receipt: LegacyPluginLinkMigrationReceipt
): Promise<void> {
  await writeJsonAtomically(
    path.join(backupDir, "migration.json"),
    receipt as unknown as JsonObject
  );
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function sameStringArray(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

async function pathEntryExists(entryPath: string): Promise<boolean> {
  try {
    await lstat(entryPath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function parseLockfileScalar(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value;
    }
  }
  return value;
}

async function synchronizeProfileDependencies(
  profileDir: string,
  packageManager: ProfilePackageManager
): Promise<void> {
  try {
    await execFileAsync(
      packageManager.executable,
      [
        ...(packageManager.prefixArgs ?? []),
        "install",
        ...(packageManager.installArgs ?? [])
      ],
      {
        cwd: profileDir,
        env: {
          ...(packageManager.environment ?? process.env),
          ELECTRON_RUN_AS_NODE: "1"
        },
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: 120_000
      }
    );
  } catch (error) {
    const childProcessError = error as { stdout?: unknown; stderr?: unknown };
    const detail = [childProcessError.stdout, childProcessError.stderr]
      .map((value) => String(value ?? "").trim())
      .filter((value) => value !== "")
      .join("\n")
      .slice(0, 2000);
    throw new Error(
      `Failed to synchronize DSH profile dependencies at ${profileDir}${
        detail === "" ? "" : `: ${detail}`
      }`,
      { cause: error }
    );
  }
}

async function validatePlugin(pluginDir: string): Promise<JsonObject> {
  const manifest = JSON.parse(
    await readFile(path.join(pluginDir, "package.json"), "utf8")
  ) as JsonObject;
  const patch = asObject(asObject(manifest.dsh).bundle).patch;
  if (
    manifest.name !== PLUGIN_NAME ||
    patch !== "./cordis.patch.yml"
  ) {
    throw new Error(`Invalid embedded Arkme plugin at ${pluginDir}`);
  }
  await validateRegularPluginFiles(pluginDir, [
    "cordis.patch.yml",
    "lib/index.js",
    "lib/client.js"
  ]);
  return manifest;
}

async function validateRegularPluginFiles(
  pluginDir: string,
  relativePaths: readonly string[]
): Promise<void> {
  for (const relativePath of relativePaths) {
    let stat;
    try {
      stat = await lstat(path.join(pluginDir, relativePath));
    } catch (cause) {
      throw new Error(
        `Invalid embedded Arkme plugin at ${pluginDir}: required file is unavailable: ${relativePath}`,
        { cause }
      );
    }
    if (!stat.isFile()) {
      throw new Error(
        `Invalid embedded Arkme plugin at ${pluginDir}: required path is not a regular file: ${relativePath}`
      );
    }
  }
}

async function readManifest(manifestPath: string): Promise<JsonObject | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Harness profile manifest must contain an object: ${manifestPath}`);
    }
    return parsed as JsonObject;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

async function writeIfMissing(filePath: string, contents: string): Promise<void> {
  try {
    await access(filePath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    await writeFile(filePath, contents, { flag: "wx" });
  }
}

async function ensurePluginSymlink(profileDir: string, pluginDir: string): Promise<void> {
  const linkPath = path.join(
    profileDir,
    "node_modules",
    "@senguoyun",
    "dsh-arkme"
  );
  await mkdir(path.dirname(linkPath), { recursive: true });

  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`${linkPath} exists and is not a symbolic link`);
    }
    const [resolvedLink, resolvedPlugin] = await Promise.all([
      realpath(linkPath).catch(() => null),
      realpath(pluginDir)
    ]);
    if (resolvedLink !== null && resolvedLink === resolvedPlugin) return;
    await unlink(linkPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  await symlink(pluginDir, linkPath, "junction");
}

async function assertPluginMaterialized(profileDir: string, pluginDir: string): Promise<void> {
  const linkPath = path.join(
    profileDir,
    "node_modules",
    "@senguoyun",
    "dsh-arkme"
  );
  const [resolvedLink, resolvedPlugin] = await Promise.all([
    realpath(linkPath).catch(() => null),
    realpath(pluginDir)
  ]);
  if (resolvedLink !== resolvedPlugin) {
    throw new Error(
      "Profile package manager did not materialize the embedded Arkme plugin at the declared path"
    );
  }
}

async function physicalPluginMatches(
  pluginDir: string,
  expectedVersion: string
): Promise<boolean> {
  try {
    const stat = await lstat(pluginDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  const health = await inspectPluginDirectory(pluginDir);
  return health.healthy && health.version === expectedVersion;
}

async function assertPhysicalPluginMaterialized(
  pluginDir: string,
  expectedVersion: string
): Promise<void> {
  if (!await physicalPluginMatches(pluginDir, expectedVersion)) {
    throw new Error(
      `Profile package manager did not materialize a healthy physical Arkme plugin ${expectedVersion} at ${pluginDir}`
    );
  }
}

async function removeManagedPluginEntry(pluginDir: string): Promise<void> {
  try {
    const stat = await lstat(pluginDir);
    if (stat.isSymbolicLink()) {
      await unlink(pluginDir);
      return;
    }
    await rm(pluginDir, { recursive: true, force: true });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function migratePluginLinkIfNeeded(profileDir: string): Promise<void> {
  const linkPath = path.join(
    profileDir,
    "node_modules",
    "@senguoyun",
    "dsh-arkme"
  );
  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink()) return;
    const backupPath = `${linkPath}.backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await rename(linkPath, backupPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function writeManifestAtomically(
  manifestPath: string,
  manifest: JsonObject
): Promise<void> {
  await writeJsonAtomically(manifestPath, manifest);
}

async function writeJsonAtomically(
  jsonPath: string,
  value: JsonObject
): Promise<void> {
  await writeTextAtomically(jsonPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomically(
  targetPath: string,
  contents: string
): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, {
      flag: "wx"
    });
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
