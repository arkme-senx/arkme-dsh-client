import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { productionPluginFingerprint } from "./production-plugin-fingerprint.mjs";

const catalogReference = "catalog:production";
const fullCommitPattern = /#([0-9a-f]{40})$/i;
const {
  packageName,
  packageVersion: productionVersion,
  commit: productionCommit,
  repository: productionRepository,
  dependencySpec: productionDependencySpec,
  tarball: productionTarball,
  importerResolution: productionImporterResolution,
  packageResolutionKey: productionPackageResolutionKey,
  snapshotKey: productionSnapshotKey,
  integrity: productionIntegrity,
  packageEntrySha256: productionPackageEntrySha256,
  snapshotSha256: productionSnapshotSha256,
  allowBuilds: productionAllowBuilds,
  unorderedArrayFields
} = productionPluginFingerprint;
const productionAllowBuildsKeys = Object.freeze([
  `${packageName}@${productionDependencySpec}`,
  `${packageName}@${productionTarball}`
]);
const provenanceFileName = "PLUGIN_PROVENANCE.json";
const provenanceTempPrefix = `.${provenanceFileName}.`;

export function assertProductionManifestReferencesCatalog(manifest, manifestName) {
  const expectedSection = manifestName === "root" ? "devDependencies" : "dependencies";
  const forbiddenSection = manifestName === "root" ? "dependencies" : "devDependencies";
  const dependency = manifest?.[expectedSection]?.[packageName];
  const forbiddenDependency = manifest?.[forbiddenSection]?.[packageName];
  if (forbiddenDependency !== undefined) {
    throw new Error(
      `${manifestName} manifest must declare ${packageName} only in ${expectedSection}`
    );
  }
  if (dependency !== catalogReference) {
    throw new Error(
      `${manifestName} manifest must reference ${packageName} as ${catalogReference}`
    );
  }
}

export async function readProductionPluginSource({ workspaceManifestPath, lockfilePath }) {
  const projectRoot = path.dirname(workspaceManifestPath);
  const [workspaceText, lockfileText, rootManifestText, runtimeManifestText] =
    await Promise.all([
      readFile(workspaceManifestPath, "utf8"),
      readFile(lockfilePath, "utf8"),
      readFile(path.join(projectRoot, "package.json"), "utf8"),
      readFile(path.join(projectRoot, "runtime", "package.json"), "utf8")
    ]);

  const workspace = parse(workspaceText);
  const lockfile = parse(lockfileText);
  assertProductionManifestReferencesCatalog(JSON.parse(rootManifestText), "root");
  assertProductionManifestReferencesCatalog(JSON.parse(runtimeManifestText), "runtime");

  const dependencySpec = workspace?.catalogs?.production?.[packageName];
  if (typeof dependencySpec !== "string") {
    throw new Error(`production catalog is missing ${packageName}`);
  }

  const commitMatch = dependencySpec.match(fullCommitPattern);
  if (!commitMatch || !dependencySpec.startsWith("git+ssh://")) {
    throw new Error(
      `production catalog dependency for ${packageName} must end with a full 40-character Git commit`
    );
  }
  if (dependencySpec !== productionDependencySpec) {
    throw new Error(
      `production catalog dependency must equal the exact production dependency: ${productionDependencySpec}`
    );
  }
  if (workspace?.dangerouslyAllowAllBuilds) {
    throw new Error(
      "dangerouslyAllowAllBuilds must not enable dependency builds globally"
    );
  }
  assertExactAllowBuilds(workspace?.allowBuilds);

  const lockedCatalog = lockfile?.catalogs?.production?.[packageName];
  if (lockedCatalog?.specifier !== productionDependencySpec) {
    throw new Error(`lockfile production catalog does not match ${dependencySpec}`);
  }
  if (lockedCatalog.version !== productionVersion) {
    throw new Error(`lockfile production catalog version must be ${productionVersion}`);
  }

  const rootResolution = readImporterResolution({
    importer: lockfile?.importers?.["."],
    importerName: "root",
    expectedSection: "devDependencies",
    forbiddenSection: "dependencies"
  });
  const runtimeResolution = readImporterResolution({
    importer: lockfile?.importers?.runtime,
    importerName: "runtime",
    expectedSection: "dependencies",
    forbiddenSection: "devDependencies"
  });

  const packageResolutionKey = productionPackageResolutionKey;
  const packageEntry = lockfile?.packages?.[packageResolutionKey];
  if (!isMapping(packageEntry?.resolution)) {
    throw new Error(`lockfile package resolution is missing for ${packageResolutionKey}`);
  }
  assertOnlyReviewedProductionKey(
    lockfile?.packages,
    packageResolutionKey,
    "package resolution"
  );
  if (packageEntry.version !== productionVersion) {
    throw new Error(`lockfile package version must be ${productionVersion}`);
  }
  const packageResolution = packageEntry.resolution;
  if (packageResolution.tarball !== productionTarball) {
    const resolvedCommitMatch = typeof packageResolution.tarball === "string"
      ? packageResolution.tarball.match(/\/([0-9a-f]{40})$/i)
      : undefined;
    const resolvedCommit = resolvedCommitMatch?.[1]?.toLowerCase();
    if (resolvedCommit && resolvedCommit !== productionCommit) {
      throw new Error(
        `production plugin commit mismatch: expected ${productionCommit}, resolved ${resolvedCommit}`
      );
    }
    throw new Error("lockfile package resolution must exactly describe the pinned Git tarball");
  }
  if (packageResolution.gitHosted !== true
      || typeof packageResolution.integrity !== "string"
      || packageResolution.integrity.trim() === "") {
    throw new Error("lockfile package resolution must exactly describe the pinned Git tarball");
  }
  if (packageResolution.integrity !== productionIntegrity) {
    throw new Error(
      "lockfile package integrity must equal the reviewed production integrity"
    );
  }
  assertCanonicalFingerprint(
    packageEntry,
    productionPackageEntrySha256,
    "lockfile production package entry fingerprint mismatch"
  );

  const snapshot = lockfile?.snapshots?.[productionSnapshotKey];
  if (snapshot === undefined) {
    throw new Error(`lockfile snapshot is missing for ${productionSnapshotKey}`);
  }
  if (!isMapping(snapshot)) {
    throw new Error(`lockfile snapshot must be a mapping for ${productionSnapshotKey}`);
  }
  assertOnlyReviewedProductionKey(
    lockfile?.snapshots,
    productionSnapshotKey,
    "snapshot key"
  );
  assertCanonicalFingerprint(
    snapshot,
    productionSnapshotSha256,
    "lockfile production snapshot fingerprint mismatch"
  );

  return {
    packageName,
    packageVersion: productionVersion,
    repository: productionRepository,
    commit: productionCommit,
    dependencySpec: productionDependencySpec
  };
}

export async function stageRuntimeWithStableProductionSource({
  readSource,
  resetRuntime,
  deployRuntime,
  materializeRuntime
}) {
  const preflightSource = await readSource();
  await resetRuntime();
  await deployRuntime();
  await materializeRuntime();
  const postDeploySource = await readSource();
  if (!isDeepStrictEqual(preflightSource, postDeploySource)) {
    throw new Error("production plugin source changed during runtime deployment");
  }
  return postDeploySource;
}

export async function verifyRuntimePlugin({ pluginDir, runtimeRoot, source }) {
  const [runtimeRealPath, pluginRealPath, pluginStats] = await Promise.all([
    realpath(runtimeRoot),
    realpath(pluginDir),
    lstat(pluginDir)
  ]);
  if (!pluginStats.isDirectory()) {
    throw new Error("runtime plugin must be a real directory, not a symbolic link");
  }
  if (pluginRealPath !== runtimeRealPath
      && !pluginRealPath.startsWith(`${runtimeRealPath}${path.sep}`)) {
    throw new Error("runtime plugin must be contained within the runtime root");
  }

  await assertRequiredRuntimeFile(pluginDir, pluginRealPath, "package.json");
  const manifest = JSON.parse(await readFile(path.join(pluginDir, "package.json"), "utf8"));
  if (source?.packageName !== packageName || manifest?.name !== packageName) {
    throw new Error(`runtime plugin package name must be ${packageName}`);
  }
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error("runtime plugin package version must be a non-empty string");
  }
  if (manifest.version !== source.packageVersion) {
    throw new Error(
      `runtime plugin package version must equal production source version ${source.packageVersion}`
    );
  }
  if (manifest?.dsh?.bundle?.patch !== "./cordis.patch.yml") {
    throw new Error("runtime plugin bundle patch must be ./cordis.patch.yml");
  }

  await Promise.all([
    assertRequiredRuntimeFile(pluginDir, pluginRealPath, "cordis.patch.yml"),
    assertRequiredRuntimeFile(pluginDir, pluginRealPath, path.join("lib", "index.js")),
    assertRequiredRuntimeFile(pluginDir, pluginRealPath, path.join("lib", "client.js"))
  ]);
  await assertRuntimeTreeHasNoSymlinks(pluginDir);

  return {
    packageName: manifest.name,
    packageVersion: manifest.version
  };
}

export async function writePluginProvenance({ pluginDir, source, packageVersion }) {
  if (packageVersion !== source.packageVersion) {
    throw new Error(
      `provenance package version must equal production source version ${source.packageVersion}`
    );
  }
  const provenancePath = path.join(pluginDir, provenanceFileName);
  const temporaryPath = path.join(
    pluginDir,
    `${provenanceTempPrefix}${randomUUID()}.tmp`
  );
  const contents = `${JSON.stringify({
    schemaVersion: 1,
    source: "git",
    repository: source.repository,
    commit: source.commit,
    packageName: source.packageName,
    packageVersion
  }, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, provenancePath);
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "provenance publication failed and temporary-file cleanup failed"
      );
    }
    throw error;
  }
  return provenancePath;
}

export function validatePackagedPluginMetadata({ manifest, provenance, expectedSource }) {
  if (
    provenance?.schemaVersion !== 1
    || provenance?.source !== "git"
    || provenance?.repository !== expectedSource?.repository
    || provenance?.commit !== expectedSource?.commit
    || provenance?.packageName !== expectedSource?.packageName
    || provenance?.packageVersion !== expectedSource?.packageVersion
    || manifest?.name !== expectedSource?.packageName
    || manifest?.version !== expectedSource?.packageVersion
    || provenance?.packageName !== manifest?.name
    || provenance?.packageVersion !== manifest?.version
  ) {
    throw new Error("Packaged Arkme plugin source metadata is inconsistent");
  }
}

export async function verifyRuntimePluginProvenance({ pluginDir, runtimeRoot, source }) {
  const verifiedPlugin = await verifyRuntimePlugin({ pluginDir, runtimeRoot, source });
  const [manifest, provenance] = await Promise.all([
    readJsonFile(path.join(pluginDir, "package.json"), "runtime plugin manifest"),
    readJsonFile(
      path.join(pluginDir, "PLUGIN_PROVENANCE.json"),
      "runtime plugin provenance"
    )
  ]);
  try {
    validatePackagedPluginMetadata({ manifest, provenance, expectedSource: source });
  } catch {
    throw new Error("runtime plugin source metadata is inconsistent");
  }
  return verifiedPlugin;
}

export async function prepareRuntimePlugin({
  pluginDir,
  runtimeRoot,
  source,
  importPlugin
}) {
  const verifiedPlugin = await verifyRuntimePlugin({ pluginDir, runtimeRoot, source });
  const provenancePath = path.join(pluginDir, provenanceFileName);
  try {
    await writePluginProvenance({
      pluginDir,
      source,
      packageVersion: verifiedPlugin.packageVersion
    });
    await importPlugin(path.join(pluginDir, "lib", "index.js"));
    await verifyRuntimePluginProvenance({ pluginDir, runtimeRoot, source });
    return { ...verifiedPlugin, provenancePath };
  } catch (error) {
    await rollbackPluginProvenance(
      pluginDir,
      error,
      "runtime plugin preparation failed and provenance cleanup failed"
    );
  }
}

export async function prepareRuntimePluginTransaction({
  pluginDir,
  runtimeRoot,
  source,
  importPlugin,
  finalizeRuntime
}) {
  try {
    const preparedPlugin = await prepareRuntimePlugin({
      pluginDir,
      runtimeRoot,
      source,
      importPlugin
    });
    await finalizeRuntime();
    await verifyRuntimePluginProvenance({ pluginDir, runtimeRoot, source });
    return preparedPlugin;
  } catch (error) {
    await rollbackPluginProvenance(
      pluginDir,
      error,
      "runtime plugin transaction failed and provenance cleanup failed"
    );
  }
}

async function rollbackPluginProvenance(pluginDir, originalError, aggregateMessage) {
  try {
    await removePluginProvenanceArtifacts(pluginDir);
  } catch (cleanupError) {
    throw new AggregateError([originalError, cleanupError], aggregateMessage);
  }
  throw originalError;
}

async function removePluginProvenanceArtifacts(pluginDir) {
  await rm(path.join(pluginDir, provenanceFileName), { force: true });
  const temporaryFiles = (await readdir(pluginDir)).filter((entry) => (
    entry.startsWith(provenanceTempPrefix) && entry.endsWith(".tmp")
  ));
  await Promise.all(temporaryFiles.map((entry) => (
    rm(path.join(pluginDir, entry), { force: true })
  )));
}

async function assertRequiredRuntimeFile(pluginDir, pluginRealPath, relativePath) {
  const requiredPath = path.join(pluginDir, relativePath);
  let requiredStats;
  try {
    requiredStats = await lstat(requiredPath);
  } catch {
    throw new Error(`runtime plugin is missing required file: ${relativePath}`);
  }
  if (!requiredStats.isFile() || requiredStats.isSymbolicLink()) {
    throw new Error(`runtime plugin required path must be a regular file: ${relativePath}`);
  }
  const requiredRealPath = await realpath(requiredPath);
  if (!isEqualToOrInside(requiredRealPath, pluginRealPath)) {
    throw new Error(`runtime plugin required file must stay inside the plugin: ${relativePath}`);
  }
}

async function assertRuntimeTreeHasNoSymlinks(pluginDir, relative = "") {
  for (const entry of await readdir(path.join(pluginDir, relative), { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`runtime plugin tree must not contain symbolic links: ${childRelative}`);
    }
    if (entry.isDirectory()) {
      await assertRuntimeTreeHasNoSymlinks(pluginDir, childRelative);
    }
  }
}

async function readJsonFile(filePath, description) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${description} at ${filePath}`, { cause: error });
  }
}

function isEqualToOrInside(candidatePath, parentPath) {
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}${path.sep}`);
}

function assertExactAllowBuilds(allowBuilds) {
  const arkmeGrants = isMapping(allowBuilds)
    ? Object.entries(allowBuilds).filter(([key]) => (
      key === packageName || key.startsWith(`${packageName}@`)
    ))
    : [];
  const reviewedKeys = new Set(productionAllowBuildsKeys);
  if (arkmeGrants.length !== productionAllowBuildsKeys.length
      || arkmeGrants.some(([key, value]) => !reviewedKeys.has(key) || value !== true)) {
    throw new Error(
      `allowBuilds must contain exactly the pinned Arkme build grants: ${productionAllowBuildsKeys.join(", ")}`
    );
  }
  if (!isDeepStrictEqual(
    canonicalizeLockfileValue(allowBuilds),
    canonicalizeLockfileValue(productionAllowBuilds)
  )) {
    throw new Error(
      "allowBuilds must exactly match the reviewed production build policy"
    );
  }
}

function assertOnlyReviewedProductionKey(entries, expectedKey, description) {
  const productionKeys = isMapping(entries)
    ? Object.keys(entries).filter((key) => key.startsWith(`${packageName}@`))
    : [];
  if (productionKeys.length !== 1 || productionKeys[0] !== expectedKey) {
    throw new Error(
      `lockfile must contain exactly the reviewed production ${description}: ${expectedKey}`
    );
  }
}

function assertCanonicalFingerprint(value, expectedDigest, message) {
  const actualDigest = createHash("sha256")
    .update(JSON.stringify(canonicalizeLockfileValue(value)))
    .digest("hex");
  if (actualDigest !== expectedDigest) {
    throw new Error(`${message}: expected ${expectedDigest}, received ${actualDigest}`);
  }
}

function canonicalizeLockfileValue(value, fieldName = "") {
  if (Array.isArray(value)) {
    const canonicalItems = value.map((entry) => canonicalizeLockfileValue(entry));
    if (unorderedArrayFields.includes(fieldName)) {
      canonicalItems.sort((left, right) => {
        const leftText = JSON.stringify(left);
        const rightText = JSON.stringify(right);
        return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
      });
    }
    return canonicalItems;
  }
  if (!isMapping(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => (
    [key, canonicalizeLockfileValue(value[key], key)]
  )));
}

function readImporterResolution({
  importer,
  importerName,
  expectedSection,
  forbiddenSection
}) {
  const dependency = importer?.[expectedSection]?.[packageName];
  const forbiddenDependency = importer?.[forbiddenSection]?.[packageName];
  if (!isMapping(dependency) || forbiddenDependency !== undefined) {
    throw new Error(
      `lockfile ${importerName} importer must declare ${packageName} in ${expectedSection}`
    );
  }
  if (dependency.specifier !== catalogReference) {
    throw new Error(
      `lockfile ${importerName} importer must reference ${packageName} as ${catalogReference}`
    );
  }
  if (typeof dependency.version !== "string"
      || stripPeerSuffix(dependency.version) !== productionTarball) {
    throw new Error(
      `lockfile ${importerName} importer version must resolve to the exact production tarball`
    );
  }
  if (dependency.version !== productionImporterResolution) {
    throw new Error(
      `lockfile ${importerName} importer version must equal the exact production resolution`
    );
  }
  return dependency;
}

function stripPeerSuffix(version) {
  return version.replace(/\([^()]*\)$/, "");
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
