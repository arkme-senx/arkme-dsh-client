import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { materializeRuntimeNodeModules } from "./materialize-runtime-node-modules.mjs";
import { installBundledPnpmShim } from "./install-bundled-pnpm-shim.mjs";
import { patchDshBundledPnpm } from "./patch-dsh-bundled-pnpm.mjs";
import { patchDshProfileBundleResolution } from "./patch-dsh-profile-bundle-resolution.mjs";
import {
  RUNTIME_PLUGIN_SEED_DIRECTORY,
  buildRuntimePluginPackArgs,
  createRuntimePluginSeed
} from "./runtime-plugin-seed.mjs";
import {
  prepareRuntimePluginTransaction,
  readProductionPluginSource,
  stageRuntimeWithStableProductionSource
} from "./production-plugin-source.mjs";
import {
  buildElectronRebuildArgs,
  buildRuntimeDeployArgs,
  buildSpawnOptions,
  disableNodePtySpectreMitigation,
  isRuntimeFilePrunable
} from "./runtime-rebuild.mjs";
import {
  buildRuntimeEnvironment,
  pruneTargetSpecificNodePtyArtifacts,
  resolveRuntimeArchitecture,
  runtimeDirectory
} from "./runtime-architecture.mjs";
import { assertElectronHarnessVersion } from "./runtime/electron-harness-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeManifest = JSON.parse(
  await readFile(path.join(projectRoot, "runtime", "package.json"), "utf8")
);
const harnessVersion = runtimeManifest.dependencies?.["@deepseek-ai/dsh"];
assertElectronHarnessVersion(harnessVersion);
const runtimeArch = resolveRuntimeArchitecture(
  process.env.ARKME_RUNTIME_ARCH,
  process.arch
);
const runtimeRoot = runtimeDirectory(projectRoot, runtimeArch);
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const productionPluginSource = await stageRuntimeWithStableProductionSource({
  readSource: () => readProductionPluginSource({
    workspaceManifestPath: path.join(projectRoot, "pnpm-workspace.yaml"),
    lockfilePath: path.join(projectRoot, "pnpm-lock.yaml")
  }),
  resetRuntime: async () => {
    await rm(runtimeRoot, { recursive: true, force: true });
    await mkdir(path.dirname(runtimeRoot), { recursive: true });
  },
  deployRuntime: async () => {
    const modulesMetadata = await readFile(
      path.join(projectRoot, "node_modules", ".modules.yaml"),
      "utf8"
    );
    const encodedStorePath = modulesMetadata.match(
      /"storeDir":\s*"((?:\\.|[^"])*)"/
    )?.[1];
    if (encodedStorePath === undefined) {
      throw new Error("Cannot determine the pnpm store used by the installed dependencies");
    }
    const storePath = JSON.parse(`"${encodedStorePath}"`);
    await run(
      pnpmExecutable,
      buildRuntimeDeployArgs({ storePath, runtimeRoot }),
      projectRoot,
      { env: buildRuntimeEnvironment(process.env, runtimeArch) }
    );
  },
  materializeRuntime: async () => {
    await materializeRuntimeNodeModules(runtimeRoot);
    await installBundledPnpmShim(path.join(runtimeRoot, "node_modules"), process.platform);
    await patchDshBundledPnpm(
      path.join(runtimeRoot, "node_modules", "@deepseek-ai", "dsh")
    );
    await patchDshProfileBundleResolution(
      path.join(runtimeRoot, "node_modules", "@deepseek-ai", "dsh-app-boot")
    );
  }
});

await assertRuntimeDependencyVersion("@deepseek-ai/dsh/package.json", harnessVersion);
await assertRuntimeDependency("@deepseek-ai/dsh-app-boot/package.json");
await assertRuntimeDependency("pnpm/bin/pnpm.cjs");
await assertRuntimeDependency("@deepseek-ai/cosmokit/package.json");
await assertRuntimeDependency("js-yaml/package.json");
await assertRuntimeDependency("@senguoyun/dsh-arkme/package.json");

const stagedPlugin = path.join(
  runtimeRoot,
  "node_modules",
  "@senguoyun",
  "dsh-arkme"
);
await prepareRuntimePluginTransaction({
  pluginDir: stagedPlugin,
  runtimeRoot,
  source: productionPluginSource,
  importPlugin: async (stagedPluginEntry) => run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(pathToFileURL(stagedPluginEntry).href)})`
    ],
    projectRoot
  ),
  finalizeRuntime: async () => {
    // The desktop shell owns this addon. pnpm's legacy deploy can copy root
    // optional dependencies into the filtered Harness tree, so remove the
    // client-only package before runtime materialization is finalized.
    await rm(
      path.join(
        runtimeRoot,
        "node_modules",
        "@arkme",
        "macos-notification-permission"
      ),
      { recursive: true, force: true }
    );

    // `pnpm deploy --legacy` leaves a workspace backlink inside the virtual
    // store. Its target is outside the copied runtime, so remove it before
    // electron-builder packages the directory.
    await rm(
      path.join(
        runtimeRoot,
        "node_modules",
        ".pnpm",
        "node_modules",
        "@jotmo",
        "harness-runtime"
      ),
      { force: true }
    );

    if (process.platform === "win32") {
      const nodePtyGypPaths = [
        path.join(runtimeRoot, "node_modules", "node-pty", "binding.gyp"),
        path.join(
          runtimeRoot,
          "node_modules",
          ".pnpm",
          "node_modules",
          "node-pty",
          "binding.gyp"
        ),
        path.join(
          projectRoot,
          "node_modules",
          ".pnpm",
          "node_modules",
          "node-pty",
          "binding.gyp"
        )
      ];
      for (const nodePtyGypPath of nodePtyGypPaths) {
        try {
          const nodePtyGyp = await readFile(nodePtyGypPath, "utf8");
          await writeFile(
            nodePtyGypPath,
            disableNodePtySpectreMitigation(nodePtyGyp),
            "utf8"
          );
        } catch (error) {
          if (error && typeof error === "object" && "code" in error
              && error.code === "ENOENT") {
            continue;
          }
          throw error;
        }
      }
    }

    const directoryPickerWorker = path.join(
      runtimeRoot,
      "node_modules",
      "@deepseek-ai",
      "dsh-host-directory-picker-native",
      "lib",
      "worker.cjs"
    );
    await writeFile(
      directoryPickerWorker,
      await readFile(
        path.join(projectRoot, "scripts", "directory-picker-bridge-worker.cjs"),
        "utf8"
      ),
      "utf8"
    );

    await pruneRuntimeFiles(runtimeRoot);

    const rebuildMain = fileURLToPath(import.meta.resolve("@electron/rebuild"));
    const rebuildCli = path.join(path.dirname(rebuildMain), "cli.js");
    await run(
      process.execPath,
      buildElectronRebuildArgs({
        rebuildCli,
        electronVersion: "43.2.0",
        platform: process.platform,
        arch: runtimeArch,
        moduleDir: runtimeRoot
      }),
      projectRoot
    );
    if (process.platform === "darwin") {
      await pruneTargetSpecificNodePtyArtifacts(runtimeRoot);
    }
  }
});

await createRuntimePluginSeed({
  pluginDir: stagedPlugin,
  seedDir: path.join(runtimeRoot, RUNTIME_PLUGIN_SEED_DIRECTORY),
  pack: async destinationDirectory => {
    await run(
      pnpmExecutable,
      buildRuntimePluginPackArgs(destinationDirectory),
      stagedPlugin
    );
    const artifacts = (await readdir(destinationDirectory))
      .filter(name => name.endsWith(".tgz"));
    if (artifacts.length !== 1) {
      throw new Error(
        `Expected one packed Arkme plugin artifact, found ${artifacts.length}`
      );
    }
    return path.join(destinationDirectory, artifacts[0]);
  }
});

async function run(command, args, cwd, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      ...buildSpawnOptions({ platform: process.platform, command }),
      ...options
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${signal ?? `code ${code ?? "unknown"}`}`));
    });
  });
}

async function assertRuntimeDependency(relativePath) {
  try {
    await access(path.join(runtimeRoot, "node_modules", relativePath));
  } catch {
    throw new Error(`Runtime dependency was not materialized at top level: ${relativePath}`);
  }
}

async function assertRuntimeDependencyVersion(relativePath, expectedVersion) {
  const manifest = JSON.parse(
    await readFile(path.join(runtimeRoot, "node_modules", relativePath), "utf8")
  );
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Runtime dependency ${relativePath} resolved to ${manifest.version}; expected ${expectedVersion}`
    );
  }
}

async function pruneRuntimeFiles(root, relative = "") {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name);
    const childPath = path.join(root, childRelative);
    if (entry.isDirectory()) {
      await pruneRuntimeFiles(root, childRelative);
    } else if (entry.isFile() && isRuntimeFilePrunable(childRelative)) {
      await rm(childPath, { force: true });
    }
  }
}
