import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractFile, listPackage } from "@electron/asar";
import electronBinary from "electron";
import {
  assertRuntimeFreePaths,
  assertRuntimeFreeResources,
  normalizeArchivePath,
  resolvePackagedSmokeEnvironment
} from "./packaged-smoke-lib.mjs";
import { buildArchitectureLaunch } from "./runtime-architecture.mjs";
import {
  packagedAppLayout,
  packagedAppLayoutFromRoot,
  resolvePackagedSmokeAppRoot,
  resolvePackagedSmokePlatform
} from "./packaged-layout.mjs";

const execFileAsync = promisify(execFile);
const smokeArgs = process.argv.slice(2);
const platform = resolvePackagedSmokePlatform(smokeArgs);
const packagedAppRoot = resolvePackagedSmokeAppRoot(smokeArgs);
const defaultLayout = packagedAppLayout(process.cwd(), platform);
const configLayout = packagedAppRoot === undefined
  ? defaultLayout
  : packagedAppLayoutFromRoot(packagedAppRoot, platform);
const packagedFiles = new Set(
  listPackage(configLayout.appAsar, { isPack: false }).map(normalizeArchivePath)
);
const packagedEnvironment = resolvePackagedSmokeEnvironment(
  extractFile(configLayout.appAsar, "dist/runtime-service-config.json")
);
const layout = packagedAppLayoutFromRoot(
  configLayout.appRoot,
  platform,
  packagedEnvironment.environment === "test" ? "arkme Test" : "arkme"
);
assertRuntimeFreePaths([...packagedFiles]);
for (const requiredFile of ["/dist/main.js", "/dist/preload.cjs", "/dist/desktop-capabilities.js", "/dist/runtime/manager.js"]) {
  if (!packagedFiles.has(requiredFile)) throw new Error(`Packaged app is missing ${requiredFile}`);
}
await assertRuntimeFreeResources(layout.resources);
const preloadProbe = spawnSync(
  electronBinary,
  [path.resolve("scripts/preload-smoke.cjs"), path.join(layout.appAsar, "dist/preload.cjs")],
  { encoding: "utf8", timeout: 15_000 }
);
if (preloadProbe.status !== 0) {
  const output = `${preloadProbe.stdout ?? ""}${preloadProbe.stderr ?? ""}`.trim();
  throw new Error(`Packaged Arkme preload smoke failed${output ? `\n${output}` : ""}`);
}
const appData = await mkdtemp(path.join(tmpdir(), "arkme-dynamic-runtime-smoke-"));
const launch = platform === "darwin"
  ? buildArchitectureLaunch(layout.electron, [], process.env.ARKME_PACKAGED_EXEC_ARCH)
  : { command: layout.electron, args: [] };
const child = spawn(launch.command, launch.args, {
  detached: platform !== "win32",
  env: {
    ...process.env,
    ARKME_APP_DATA_PATH: appData,
    ...(platform === "linux" ? { ELECTRON_DISABLE_SANDBOX: "1" } : {})
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
child.stdout.on("data", chunk => { output = `${output}${chunk}`.slice(-16_384); });
child.stderr.on("data", chunk => { output = `${output}${chunk}`.slice(-16_384); });
try {
  const userData = path.join(appData, packagedEnvironment.userDataDirectoryName);
  const statePath = path.join(userData, "runtime-manager", "electron-v1", "state.json");
  const logPath = path.join(userData, "logs", "desktop-startup.log");
  const deadline = Date.now() + 5 * 60_000;
  let passed = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const releaseId = state.activeReleaseId;
      const release = JSON.parse(await readFile(path.join(
        userData,
        "runtime-manager",
        "electron-v1",
        "releases",
        releaseId,
        "release.json"
      ), "utf8"));
      const log = await readFile(logPath, "utf8");
      const matches = [...log.matchAll(/render-ready \{"url":"(http:\/\/127\.0\.0\.1:\d+[^" ]*)"/g)];
      const harnessUrl = matches.at(-1)?.[1];
      if (harnessUrl) {
        const pluginUpdateResponse = await fetch(new URL("/arkme-self/api", harnessUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: "plugin.update.status" })
        });
        const providerStateResponse = await fetch(new URL("/arkme-self/api", harnessUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: "provider.state" })
        });
        const pluginUpdate = pluginUpdateResponse.ok ? await pluginUpdateResponse.json() : undefined;
        const providerState = providerStateResponse.ok ? await providerStateResponse.json() : undefined;
        if (
          pluginUpdate?.ok === true
          && pluginUpdate.value?.installedVersion === release.artifacts.requiredPlugin.version
          && providerState?.ok === true
          && providerState.value?.environment === packagedEnvironment.environment
          && state.probationReleaseId === undefined
        ) {
          passed = true;
          break;
        }
      }
    } catch {
      // Runtime download, installation and Harness startup are still progressing.
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!passed) {
    throw new Error(`Packaged Arkme dynamic runtime smoke failed${output ? `\n${output}` : ""}`);
  }
  console.log("packaged Arkme dynamic runtime smoke passed");
} finally {
  await stopProcessTree(child, platform);
  await rm(appData, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });
}

async function stopProcessTree(childProcess, targetPlatform) {
  if (!childProcess.pid || childProcess.exitCode !== null) return;
  if (targetPlatform === "win32") {
    await execFileAsync("taskkill.exe", ["/PID", String(childProcess.pid), "/T", "/F"]).catch(() => undefined);
    return;
  }
  process.kill(-childProcess.pid, "SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 750));
  if (childProcess.exitCode === null) process.kill(-childProcess.pid, "SIGKILL");
}
