import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractTarZstd } from "./archive.js";
import { downloadRuntimeArtifact } from "./download.js";
import { RuntimeArtifactValidationError } from "./errors.js";
import type { ElectronRuntimeManifest } from "./manifest.js";
import type { RuntimeInstallProgress } from "./manager.js";

interface InstallElectronRuntimeOptions {
  downloadsPath: string;
  fetcher: typeof fetch;
  onProgress?: (progress: RuntimeInstallProgress) => void;
}

const DISK_SAFETY_RESERVE = 512 * 1024 * 1024;

export async function installElectronRuntimeRelease(
  manifest: ElectronRuntimeManifest,
  stagingPath: string,
  options: InstallElectronRuntimeOptions
): Promise<void> {
  await Promise.all([
    mkdir(stagingPath, { recursive: true }),
    mkdir(options.downloadsPath, { recursive: true })
  ]);
  await ensureDiskCapacity(stagingPath, manifest);
  const progress = { harnessPercent: 0, pluginPercent: 0 };
  const notify = (phase: RuntimeInstallProgress["phase"]) => options.onProgress?.({
    kind: "runtime-installing",
    phase,
    harnessPercent: progress.harnessPercent,
    pluginPercent: progress.pluginPercent
  });
  notify("download");
  const harnessDownload = path.join(options.downloadsPath, `${manifest.artifacts.harness.sha256}.tar.zst`);
  const pluginDownload = path.join(options.downloadsPath, `${manifest.artifacts.requiredPlugin.sha256}.tar.zst`);
  await Promise.all([
    downloadRuntimeArtifact({
      artifact: manifest.artifacts.harness,
      destination: harnessDownload,
      fetcher: options.fetcher,
      onProgress: percent => {
        progress.harnessPercent = percent;
        notify("download");
      }
    }),
    downloadRuntimeArtifact({
      artifact: manifest.artifacts.requiredPlugin,
      destination: pluginDownload,
      fetcher: options.fetcher,
      onProgress: percent => {
        progress.pluginPercent = percent;
        notify("download");
      }
    })
  ]);
  notify("verify");

  await extractTarZstd(harnessDownload, stagingPath, {
    maxEntries: 500_000,
    maxUnpackedBytes: manifest.artifacts.harness.unpackedSize
  });
  const pluginTarget = path.join(stagingPath, ...manifest.artifacts.requiredPlugin.target.split("/"));
  if (await exists(pluginTarget)) {
    throw new RuntimeArtifactValidationError("HARNESS_CONTAINS_PLUGIN", "Electron Harness artifact must not contain the Arkme plugin package", "install");
  }
  await mkdir(pluginTarget, { recursive: true });
  await extractTarZstd(pluginDownload, pluginTarget, {
    maxEntries: 500_000,
    maxUnpackedBytes: manifest.artifacts.requiredPlugin.unpackedSize
  });
  for (const reserved of ["runtime-environment.json", "release.json", "install-receipt.json"]) {
    if (await exists(path.join(stagingPath, reserved))) {
      throw new RuntimeArtifactValidationError(
        "RESERVED_RUNTIME_FILE",
        `Electron runtime artifact must not contain reserved file ${reserved}`,
        "install"
      );
    }
  }
  notify("install");
  await validateInstalledRuntimeLayout(manifest, stagingPath);
  await writeIntegrityReceipt(manifest, stagingPath);
  progress.harnessPercent = 100;
  progress.pluginPercent = 100;
  notify("install");
}

export async function validateInstalledElectronRuntime(
  manifest: ElectronRuntimeManifest,
  stagingPath: string
): Promise<void> {
  await validateInstalledRuntimeLayout(manifest, stagingPath);
  await verifyIntegrityReceipt(manifest, stagingPath);
}

async function validateInstalledRuntimeLayout(
  manifest: ElectronRuntimeManifest,
  stagingPath: string
): Promise<void> {
  if (await exists(path.join(stagingPath, "node"))) {
    throw new RuntimeArtifactValidationError("STANDALONE_NODE_FORBIDDEN", "Electron Harness artifact must not contain a standalone Node runtime");
  }
  const metadata = await readJson(path.join(stagingPath, manifest.artifacts.harness.metadata));
  const target = objectValue(metadata.target);
  const runtime = objectValue(metadata.runtime);
  if (
    metadata.schemaVersion !== 1
    || metadata.component !== "electron-harness"
    || metadata.version !== manifest.artifacts.harness.version
    || typeof metadata.buildId !== "string"
    || !/^[A-Za-z0-9._-]{1,128}$/.test(metadata.buildId)
    || target.os !== manifest.target.os
    || target.arch !== manifest.target.arch
    || (manifest.target.os === "linux" ? target.libc !== "glibc" : target.libc !== undefined)
    || runtime.kind !== "electron"
    || runtime.electronVersion !== "43.2.0"
    || runtime.electronMajor !== 43
    || runtime.modulesAbi !== 148
    || metadata.pnpmVersion !== manifest.pnpmVersion
  ) {
    throw new RuntimeArtifactValidationError("RUNTIME_METADATA_INCOMPATIBLE", "Installed Electron Harness runtime metadata is incompatible");
  }
  const dsh = await readJson(path.join(stagingPath, "harness", "node_modules", "@deepseek-ai", "dsh", "package.json"));
  const pnpm = await readJson(path.join(stagingPath, "harness", "node_modules", "pnpm", "package.json"));
  const pluginPath = path.join(stagingPath, ...manifest.artifacts.requiredPlugin.target.split("/"));
  const plugin = await readJson(path.join(pluginPath, "package.json"));
  if (dsh.name !== "@deepseek-ai/dsh" || dsh.version !== manifest.artifacts.harness.version) {
    throw new RuntimeArtifactValidationError("HARNESS_IDENTITY_INVALID", "Installed Electron Harness package identity is invalid");
  }
  if (pnpm.name !== "pnpm" || pnpm.version !== manifest.pnpmVersion) {
    throw new RuntimeArtifactValidationError("PNPM_IDENTITY_INVALID", "Installed Electron Harness pnpm identity is invalid");
  }
  if (plugin.name !== "@senguoyun/dsh-arkme" || plugin.version !== manifest.artifacts.requiredPlugin.version) {
    throw new RuntimeArtifactValidationError("PLUGIN_IDENTITY_MISMATCH", "Installed Arkme plugin identity is invalid");
  }
  const binName = manifest.target.os === "windows" ? "pnpm.cmd" : "pnpm";
  const nodeShim = manifest.target.os === "windows" ? "node.cmd" : "node";
  try {
    await Promise.all([
      access(path.join(stagingPath, manifest.artifacts.harness.entry)),
      access(path.join(stagingPath, "harness", "node_modules", ".bin", binName)),
      access(path.join(stagingPath, "harness", "node_modules", ".bin", nodeShim)),
      access(path.join(stagingPath, "harness", "node_modules", "pnpm", "bin", "pnpm.cjs")),
      access(path.join(pluginPath, "cordis.patch.yml")),
      access(path.join(pluginPath, "lib", "index.js")),
      access(path.join(pluginPath, "lib", "client.js"))
    ]);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    throw new RuntimeArtifactValidationError(
      "REQUIRED_FILE_MISSING",
      "Electron runtime installation is missing a required file",
      "verify",
      { cause: error }
    );
  }
}

async function writeIntegrityReceipt(manifest: ElectronRuntimeManifest, root: string): Promise<void> {
  const files: Record<string, string> = {};
  for (const relativePath of integrityPaths(manifest)) {
    files[relativePath] = await sha256File(path.join(root, ...relativePath.split("/")));
  }
  await writeFile(path.join(root, "install-receipt.json"), `${JSON.stringify({
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    files
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function verifyIntegrityReceipt(manifest: ElectronRuntimeManifest, root: string): Promise<void> {
  const receipt = await readJson(path.join(root, "install-receipt.json"));
  const files = objectValue(receipt.files);
  const expectedPaths = integrityPaths(manifest);
  if (
    receipt.schemaVersion !== 1
    || receipt.releaseId !== manifest.releaseId
    || Object.keys(files).sort().join("\n") !== [...expectedPaths].sort().join("\n")
  ) {
    throw new RuntimeArtifactValidationError("INTEGRITY_RECEIPT_INVALID", "Electron runtime installation integrity receipt is invalid");
  }
  for (const relativePath of expectedPaths) {
    const expected = files[relativePath];
    let actual: string;
    try {
      actual = await sha256File(path.join(root, ...relativePath.split("/")));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      throw new RuntimeArtifactValidationError(
        "REQUIRED_FILE_MISSING",
        `Electron runtime installation is missing required file ${relativePath}`,
        "verify",
        { cause: error }
      );
    }
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
      throw new RuntimeArtifactValidationError("INTEGRITY_MISMATCH", `Electron runtime installation integrity mismatch: ${relativePath}`);
    }
  }
}

function integrityPaths(manifest: ElectronRuntimeManifest): string[] {
  const binName = manifest.target.os === "windows" ? "pnpm.cmd" : "pnpm";
  const nodeShim = manifest.target.os === "windows" ? "node.cmd" : "node";
  const pluginTarget = manifest.artifacts.requiredPlugin.target;
  return [
    manifest.artifacts.harness.metadata,
    manifest.artifacts.harness.entry,
    "harness/node_modules/@deepseek-ai/dsh/package.json",
    "harness/node_modules/pnpm/package.json",
    "harness/node_modules/pnpm/bin/pnpm.cjs",
    `harness/node_modules/.bin/${binName}`,
    `harness/node_modules/.bin/${nodeShim}`,
    `${pluginTarget}/package.json`,
    `${pluginTarget}/cordis.patch.yml`,
    `${pluginTarget}/lib/index.js`,
    `${pluginTarget}/lib/client.js`
  ];
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function ensureDiskCapacity(root: string, manifest: ElectronRuntimeManifest): Promise<void> {
  const required = manifest.artifacts.harness.size
    + manifest.artifacts.harness.unpackedSize
    + manifest.artifacts.requiredPlugin.size
    + manifest.artifacts.requiredPlugin.unpackedSize
    + DISK_SAFETY_RESERVE;
  const disk = await statfs(root);
  const available = disk.bavail * disk.bsize;
  if (available < required) {
    throw new Error(`Insufficient disk space for Electron runtime: need ${required} bytes`);
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    return objectValue(JSON.parse(await readFile(filePath, "utf8")) as unknown);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new RuntimeArtifactValidationError(
        "REQUIRED_FILE_MISSING",
        `Electron runtime JSON is missing: ${path.basename(filePath)}`,
        "verify",
        { cause: error }
      );
    }
    if (!(error instanceof SyntaxError)) throw error;
    throw new RuntimeArtifactValidationError(
      "RUNTIME_JSON_INVALID",
      `Electron runtime JSON is invalid: ${path.basename(filePath)}`,
      "verify",
      { cause: error }
    );
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
