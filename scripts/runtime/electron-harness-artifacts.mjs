import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";
import { pack } from "tar-stream";
import { installBundledPnpmShim } from "../install-bundled-pnpm-shim.mjs";
import {
  assertElectronHarnessVersion,
  electronHarnessArtifactName,
  electronHarnessMetadata
} from "./electron-harness-lib.mjs";

const TARGETS = Object.freeze([
  Object.freeze({ os: "darwin", arch: "arm64" }),
  Object.freeze({ os: "darwin", arch: "x64" }),
  Object.freeze({ os: "windows", arch: "x64" }),
  Object.freeze({ os: "linux", arch: "x64", libc: "glibc" })
]);

function packagePlatform(target) {
  return target.os === "windows" ? "win32" : target.os;
}

function supports(values, actual) {
  if (!Array.isArray(values) || values.length === 0) return true;
  const denied = values.filter(value => value.startsWith("!")).map(value => value.slice(1));
  if (denied.includes(actual)) return false;
  const allowed = values.filter(value => !value.startsWith("!"));
  return allowed.length === 0 || allowed.includes(actual);
}

async function packageDirectories(nodeModules) {
  const packages = [];
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".pnpm") continue;
    const absolute = path.join(nodeModules, entry.name);
    if (!entry.name.startsWith("@")) {
      packages.push(absolute);
      continue;
    }
    for (const scoped of await readdir(absolute, { withFileTypes: true })) {
      if (scoped.isDirectory()) packages.push(path.join(absolute, scoped.name));
    }
  }
  return packages;
}

async function pruneNodeModules(nodeModules, target) {
  for (const packageRoot of await packageDirectories(nodeModules)) {
    const manifest = await readFile(path.join(packageRoot, "package.json"), "utf8")
      .then(JSON.parse, () => null);
    if (manifest && (
      !supports(manifest.os, packagePlatform(target))
      || !supports(manifest.cpu, target.arch)
      || !supports(manifest.libc, target.libc ?? "")
    )) {
      await rm(packageRoot, { recursive: true, force: true });
      continue;
    }
    const nestedModules = path.join(packageRoot, "node_modules");
    if (await access(nestedModules).then(() => true, () => false)) {
      await pruneNodeModules(nestedModules, target);
    }
  }
}

async function pruneNodePtyPrebuilds(nodeModules, target) {
  const nodePty = path.join(nodeModules, "node-pty");
  await rm(path.join(nodePty, "build"), { recursive: true, force: true });
  const prebuilds = path.join(nodePty, "prebuilds");
  if (!(await access(prebuilds).then(() => true, () => false))) return;
  const selected = `${packagePlatform(target)}-${target.arch}`;
  for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== selected) {
      await rm(path.join(prebuilds, entry.name), { recursive: true, force: true });
    }
  }
}

async function assertOrdinaryTree(root, relative = "") {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name);
    const info = await lstat(path.join(root, childRelative));
    if (info.isSymbolicLink()) throw new Error(`Electron Harness cannot contain a symlink: ${childRelative}`);
    if (info.isDirectory()) await assertOrdinaryTree(root, childRelative);
    else if (!info.isFile()) throw new Error(`Electron Harness path is not regular: ${childRelative}`);
  }
}

async function copyRuntimeModules(sourceModules, targetModules) {
  const sourceRoot = path.resolve(sourceModules);
  const virtualStore = path.join(sourceRoot, ".pnpm");
  await cp(sourceRoot, targetModules, {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: true,
    filter: candidate => {
      const absolute = path.resolve(candidate);
      return absolute !== virtualStore && !absolute.startsWith(`${virtualStore}${path.sep}`);
    }
  });
}

async function assertUniformDshRelease(nodeModules, expectedVersion) {
  for (const packageRoot of await packageDirectories(nodeModules)) {
    const manifest = await readFile(path.join(packageRoot, "package.json"), "utf8")
      .then(JSON.parse, () => null);
    const name = manifest?.name;
    if (
      typeof name === "string"
      && (name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"))
      && manifest.version !== expectedVersion
    ) {
      throw new Error(`${name} version ${manifest.version}; expected ${expectedVersion}`);
    }
    const nestedModules = path.join(packageRoot, "node_modules");
    if (await access(nestedModules).then(() => true, () => false)) {
      await assertUniformDshRelease(nestedModules, expectedVersion);
    }
  }
}

async function removeForeignShims(nodeModules, target) {
  const bin = path.join(nodeModules, ".bin");
  if (target.os === "windows") {
    for (const name of ["pnpm", "node"]) await rm(path.join(bin, name), { force: true });
  } else {
    for (const name of ["pnpm.cmd", "pnpm.ps1", "node.cmd", "node.ps1"]) {
      await rm(path.join(bin, name), { force: true });
    }
  }
}

export async function prepareElectronHarnessTarget({
  sourceModules,
  harnessRoot,
  target,
  version,
  buildId
}) {
  const targetModules = path.join(harnessRoot, "node_modules");
  await mkdir(harnessRoot, { recursive: true });
  await copyRuntimeModules(sourceModules, targetModules);
  await rm(path.join(targetModules, "@senguoyun", "dsh-arkme"), {
    recursive: true,
    force: true
  });
  await assertUniformDshRelease(targetModules, version);
  await pruneNodeModules(targetModules, target);
  await pruneNodePtyPrebuilds(targetModules, target);
  await installBundledPnpmShim(targetModules, packagePlatform(target));
  await removeForeignShims(targetModules, target);
  const metadata = electronHarnessMetadata({ target, version, buildId });
  await writeFile(
    path.join(harnessRoot, "runtime-metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { flag: "wx" }
  );
  await assertOrdinaryTree(harnessRoot);
  return metadata;
}

function nativeRequirements(target) {
  const platform = packagePlatform(target);
  const suffix = target.os === "windows"
    ? `${platform}-${target.arch}-msvc`
    : target.os === "linux"
      ? `${platform}-${target.arch}-gnu`
      : `${platform}-${target.arch}`;
  const prebuild = `${platform}-${target.arch}`;
  const files = [
    `node-addon-require-builtin-${suffix}/package.json`,
    `@koromix/koffi-${platform}-${target.arch}/package.json`,
    `@koromix/koffi-${platform}-${target.arch}/${platform}_${target.arch}/koffi.node`,
    `@img/sharp-${platform}-${target.arch}/package.json`,
    `node-pty/prebuilds/${prebuild}/${target.os === "windows" ? "conpty.node" : "pty.node"}`
  ];
  const patterns = [
    {
      directory: `node-addon-require-builtin-${suffix}/prebuilt`,
      pattern: new RegExp(`^${suffix}-napi-v\\d+\\.node$`),
      description: `${suffix} N-API binary`
    },
    {
      directory: `@img/sharp-${platform}-${target.arch}/lib`,
      pattern: new RegExp(`^sharp-${platform}-${target.arch}-.+\\.node$`),
      description: `sharp-${platform}-${target.arch} native binary`
    }
  ];
  if (target.os !== "windows") {
    files.push(`@img/sharp-libvips-${platform}-${target.arch}/package.json`);
    patterns.push({
      directory: `@img/sharp-libvips-${platform}-${target.arch}/lib`,
      pattern: target.os === "darwin"
        ? /^libvips-cpp\..+\.dylib$/
        : /^libvips-cpp\.so\..+$/,
      description: `sharp-libvips-${platform}-${target.arch} dynamic library`
    });
  }
  if (target.os === "darwin") {
    files.push(`node-pty/prebuilds/${prebuild}/spawn-helper`);
  } else if (target.os === "windows") {
    files.push(
      `node-pty/prebuilds/${prebuild}/conpty_console_list.node`,
      `node-pty/prebuilds/${prebuild}/conpty/conpty.dll`,
      `node-pty/prebuilds/${prebuild}/conpty/OpenConsole.exe`
    );
    patterns.push(
      {
        directory: `@img/sharp-${platform}-${target.arch}/lib`,
        pattern: /^libvips-\d+\.dll$/,
        description: `sharp-${platform}-${target.arch} libvips DLL`
      },
      {
        directory: `@img/sharp-${platform}-${target.arch}/lib`,
        pattern: /^libvips-cpp-.+\.dll$/,
        description: `sharp-${platform}-${target.arch} libvips C++ DLL`
      }
    );
  }
  return { files, patterns };
}

async function requireFiles(root, entries) {
  for (const entry of entries) await access(path.join(root, entry));
}

async function requireMatchingFiles(root, requirements) {
  for (const { directory, pattern, description } of requirements) {
    const absolute = path.join(root, directory);
    const entries = await readdir(absolute).catch(() => []);
    if (!entries.some(entry => pattern.test(entry))) {
      throw new Error(`Electron Harness is missing ${description} in ${directory}`);
    }
  }
}

async function readPackageVersion(nodeModules, packageName) {
  const manifestPath = path.join(nodeModules, ...packageName.split("/"), "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return manifest.version;
}

export async function cleanupElectronHarnessBuildPaths({
  paths,
  suppressErrors,
  remove = rm,
  warn = console.warn
}) {
  for (const candidate of paths.filter(Boolean)) {
    try {
      await remove(candidate, { recursive: true, force: true });
    } catch (error) {
      if (!suppressErrors) throw error;
      warn(`Electron Harness cleanup failed for ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function directorySize(root) {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(absolute);
    else if (entry.isFile()) total += (await stat(absolute)).size;
  }
  return total;
}

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  }, async function* (source) {
    for await (const _chunk of source) {
      // Drain the stream while the hash is updated by the previous transform.
    }
  });
  return hash.digest("hex");
}

async function walk(root, relative = "") {
  const entries = [];
  for (const item of (await readdir(path.join(root, relative), { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, item.name);
    entries.push(child);
    if (item.isDirectory()) entries.push(...await walk(root, child));
  }
  return entries;
}

function archiveEntry(archive, header, body) {
  return new Promise((resolve, reject) => {
    const callback = error => error ? reject(error) : resolve();
    if (body === undefined) archive.entry(header, callback);
    else archive.entry(header, body, callback);
  });
}

async function packDirectory(root, outputPath) {
  const archive = pack();
  const writer = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  const piping = pipeline(archive, createZstdCompress({ level: 19 }), writer);
  for (const relative of await walk(root)) {
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);
    const archivePath = relative.split(path.sep).join("/");
    if (info.isDirectory()) {
      await archiveEntry(archive, { name: `${archivePath}/`, type: "directory", mode: 0o755 });
    } else if (info.isFile()) {
      await archiveEntry(archive, {
        name: archivePath,
        type: "file",
        mode: info.mode & 0o111 ? 0o755 : 0o644,
        size: info.size
      }, await readFile(absolute));
    } else {
      throw new Error(`Electron Harness path is not regular: ${archivePath}`);
    }
  }
  archive.finalize();
  await piping;
}

export async function buildElectronHarnessArtifacts({
  sourceModules,
  output,
  version,
  buildId
}) {
  const source = path.resolve(sourceModules);
  const destination = path.resolve(output);
  if (await access(destination).then(() => true, () => false)) {
    throw new Error(`Electron Harness output already exists: ${destination}`);
  }
  assertElectronHarnessVersion(version);
  await requireFiles(source, [
    "@deepseek-ai/dsh/lib/bin.js",
    "pnpm/package.json",
    "pnpm/bin/pnpm.cjs"
  ]);
  const harnessPackageVersion = await readPackageVersion(source, "@deepseek-ai/dsh");
  if (harnessPackageVersion !== version) {
    throw new Error(`@deepseek-ai/dsh version ${harnessPackageVersion}; expected ${version}`);
  }
  const expectedPnpmVersion = electronHarnessMetadata({
    target: TARGETS[0],
    version,
    buildId
  }).pnpmVersion;
  const pnpmPackageVersion = await readPackageVersion(source, "pnpm");
  if (pnpmPackageVersion !== expectedPnpmVersion) {
    throw new Error(`pnpm version ${pnpmPackageVersion}; expected ${expectedPnpmVersion}`);
  }
  const outputParent = path.dirname(destination);
  await mkdir(outputParent, { recursive: true });
  const stagingOutput = await mkdtemp(path.join(outputParent, `.${path.basename(destination)}.staging-`));
  let temporaryRoot;
  let committed = false;
  let primaryError;
  try {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "electron-harness-artifacts-"));
    const artifacts = [];
    for (const target of TARGETS) {
      const stage = path.join(temporaryRoot, `${target.os}-${target.arch}`);
      const harnessRoot = path.join(stage, "harness");
      const metadata = await prepareElectronHarnessTarget({
        sourceModules: source,
        harnessRoot,
        target,
        version,
        buildId
      });
      const targetModules = path.join(harnessRoot, "node_modules");
      const native = nativeRequirements(target);
      await requireFiles(targetModules, [
        "@deepseek-ai/dsh/lib/bin.js",
        "pnpm/package.json",
        "pnpm/bin/pnpm.cjs",
        `.bin/${target.os === "windows" ? "pnpm.cmd" : "pnpm"}`,
        `.bin/${target.os === "windows" ? "node.cmd" : "node"}`,
        ...native.files
      ]);
      await requireMatchingFiles(targetModules, native.patterns);
      const file = electronHarnessArtifactName(target, version);
      const outputPath = path.join(stagingOutput, file);
      await packDirectory(stage, outputPath);
      artifacts.push({
        target: metadata.target,
        version: metadata.version,
        buildId: metadata.buildId,
        runtime: metadata.runtime,
        pnpmVersion: metadata.pnpmVersion,
        file,
        sha256: await sha256(outputPath),
        size: (await stat(outputPath)).size,
        unpackedSize: await directorySize(stage)
      });
      await rm(stage, { recursive: true, force: true });
    }
    const result = {
      schemaVersion: 1,
      component: "electron-harness",
      builtAt: new Date().toISOString(),
      version,
      buildId,
      runtime: {
        kind: "electron",
        electronVersion: "43.2.0",
        electronMajor: 43,
        modulesAbi: 148
      },
      pnpmVersion: "11.19.0",
      artifacts
    };
    await writeFile(
      path.join(stagingOutput, "artifact-metadata.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      { flag: "wx" }
    );
    await writeFile(
      path.join(stagingOutput, "SHA256SUMS"),
      `${artifacts.map(artifact => `${artifact.sha256}  ${artifact.file}`).join("\n")}\n`,
      { flag: "wx" }
    );
    await rename(stagingOutput, destination);
    committed = true;
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupElectronHarnessBuildPaths({
      paths: [stagingOutput, temporaryRoot],
      suppressErrors: committed || primaryError !== undefined
    });
  }
}
