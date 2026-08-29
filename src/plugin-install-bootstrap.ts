import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

const PLUGIN_NAME = "@senguoyun/dsh-arkme" as const;
const SEED_DIRECTORY = "arkme-plugin-seed";
const SEED_MANIFEST = "manifest.json";
const SEED_ARTIFACT = "dsh-arkme.tgz";
const BOOTSTRAP_RECEIPT = "desktop-plugin-bootstrap.json";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA512_PATTERN = /^[a-f0-9]{128}$/;

export interface ManagedPluginArtifact {
  artifactPath: string;
  artifactSha512: string;
  packageName: typeof PLUGIN_NAME;
  version: string;
}

export interface PluginInstallBootstrapPreparation {
  artifact: ManagedPluginArtifact;
  profilePluginDir: string;
  resetRequired: boolean;
}

interface SeedManifest {
  schemaVersion: 1;
  packageName: typeof PLUGIN_NAME;
  version: string;
  artifactFileName: typeof SEED_ARTIFACT;
  artifactSha512: string;
}

export function profilePluginDirectory(dshHome: string, profileName: string): string {
  if (
    profileName === ""
    || profileName === "."
    || profileName === ".."
    || profileName.includes("/")
    || profileName.includes("\\")
  ) {
    throw new Error("DSH profile name must be a single path segment");
  }
  return path.join(
    path.resolve(dshHome),
    "profiles",
    profileName,
    "node_modules",
    "@senguoyun",
    "dsh-arkme"
  );
}

export async function preparePluginInstallBootstrap(options: {
  resourcesPath: string;
  dshHome: string;
  appVersion: string;
  profileName: string;
}): Promise<PluginInstallBootstrapPreparation> {
  const sourceArtifact = await validateSeed(options.resourcesPath);
  const artifactPath = path.join(
    path.resolve(options.dshHome),
    "arkme-self",
    "plugin-seed",
    sourceArtifact.version,
    SEED_ARTIFACT
  );
  await copyArtifactAtomically(sourceArtifact.artifactPath, artifactPath);

  const profilePluginDir = profilePluginDirectory(options.dshHome, options.profileName);
  const artifact = { ...sourceArtifact, artifactPath };
  const resetRequired = !await bootstrapReceiptMatches(
    options.dshHome,
    options.appVersion,
    artifact
  );

  return {
    artifact,
    profilePluginDir,
    resetRequired
  };
}

export async function completePluginInstallBootstrap(options: {
  dshHome: string;
  appVersion: string;
  profileName: string;
  artifact: ManagedPluginArtifact;
  selectedPluginVersion: string;
}): Promise<void> {
  const pluginDir = profilePluginDirectory(options.dshHome, options.profileName);
  await validateInstalledPlugin(pluginDir, options.selectedPluginVersion);
  const receiptPath = path.join(
    path.resolve(options.dshHome),
    "arkme-self",
    BOOTSTRAP_RECEIPT
  );
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({
      schemaVersion: 1,
      appVersion: options.appVersion,
      packageName: options.artifact.packageName,
      version: options.artifact.version,
      artifactSha512: options.artifact.artifactSha512,
      completedAtMillis: Date.now()
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, receiptPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function bootstrapReceiptMatches(
  dshHome: string,
  appVersion: string,
  artifact: ManagedPluginArtifact
): Promise<boolean> {
  try {
    const receipt = JSON.parse(await readFile(path.join(
      path.resolve(dshHome),
      "arkme-self",
      BOOTSTRAP_RECEIPT
    ), "utf8")) as Record<string, unknown>;
    return receipt.schemaVersion === 1
      && receipt.appVersion === appVersion
      && receipt.packageName === artifact.packageName
      && receipt.version === artifact.version
      && receipt.artifactSha512 === artifact.artifactSha512
      && typeof receipt.completedAtMillis === "number"
      && Number.isFinite(receipt.completedAtMillis)
      && receipt.completedAtMillis > 0;
  } catch {
    return false;
  }
}

async function validateInstalledPlugin(pluginDir: string, expectedVersion: string): Promise<void> {
  try {
    const stat = await lstat(pluginDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("path is not a physical directory");
    }
    const manifest = JSON.parse(
      await readFile(path.join(pluginDir, "package.json"), "utf8")
    ) as Record<string, unknown>;
    if (manifest.name !== PLUGIN_NAME || manifest.version !== expectedVersion) {
      throw new Error("package metadata does not match the selected Profile plugin");
    }
    for (const relativePath of [
      "cordis.patch.yml",
      path.join("lib", "index.js"),
      path.join("lib", "client.js")
    ]) {
      if (!(await lstat(path.join(pluginDir, relativePath))).isFile()) {
        throw new Error(`required file is not regular: ${relativePath}`);
      }
    }
  } catch (cause) {
    throw new Error(`installed Arkme plugin is invalid at ${pluginDir}`, { cause });
  }
}

async function validateSeed(resourcesPath: string): Promise<ManagedPluginArtifact> {
  const seedDirectory = path.join(path.resolve(resourcesPath), SEED_DIRECTORY);
  const manifest = JSON.parse(
    await readFile(path.join(seedDirectory, SEED_MANIFEST), "utf8")
  ) as Partial<SeedManifest>;
  if (
    manifest.schemaVersion !== 1
    || manifest.packageName !== PLUGIN_NAME
    || typeof manifest.version !== "string"
    || !VERSION_PATTERN.test(manifest.version)
    || manifest.artifactFileName !== SEED_ARTIFACT
    || typeof manifest.artifactSha512 !== "string"
    || !SHA512_PATTERN.test(manifest.artifactSha512)
  ) {
    throw new Error("packaged Arkme plugin seed manifest is invalid");
  }
  const artifactPath = path.join(seedDirectory, SEED_ARTIFACT);
  const artifactSha512 = createHash("sha512")
    .update(await readFile(artifactPath))
    .digest("hex");
  if (artifactSha512 !== manifest.artifactSha512) {
    throw new Error("packaged Arkme plugin seed digest mismatch");
  }
  return {
    artifactPath,
    artifactSha512,
    packageName: PLUGIN_NAME,
    version: manifest.version
  };
}

async function copyArtifactAtomically(sourcePath: string, destinationPath: string): Promise<void> {
  await mkdir(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(sourcePath, temporaryPath);
    await rename(temporaryPath, destinationPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
