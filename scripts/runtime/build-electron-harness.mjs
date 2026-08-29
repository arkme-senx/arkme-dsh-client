import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electronBinary from "electron";
import { buildArchitectureLaunch, runtimeDirectory } from "../runtime-architecture.mjs";
import { buildElectronHarnessArtifacts } from "./electron-harness-artifacts.mjs";
import {
  assertElectronHarnessRuntime,
  assertElectronHarnessVersion
} from "./electron-harness-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const arch = process.env.ARKME_RUNTIME_ARCH?.trim() || process.arch;
const buildId = process.env.ARKME_RUNTIME_BUILD_ID?.trim();
if (!buildId) throw new Error("ARKME_RUNTIME_BUILD_ID is required so all platform artifacts share one build identity");
const runtimeRoot = runtimeDirectory(projectRoot, arch);
const runtimeManifest = JSON.parse(await readFile(path.join(projectRoot, "runtime", "package.json"), "utf8"));
const dshVersion = runtimeManifest.dependencies?.["@deepseek-ai/dsh"];
if (typeof dshVersion !== "string") throw new Error("Cannot resolve the pinned Harness version");
assertElectronHarnessVersion(dshVersion);

await run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["run", "prepare:runtime"], projectRoot, {
  ...process.env,
  ARKME_RUNTIME_ARCH: arch
});
const abiProbe = buildArchitectureLaunch(
  electronBinary,
  ["--print", "JSON.stringify({ electronVersion: process.versions.electron, modulesAbi: process.versions.modules })"],
  process.platform === "darwin" ? arch : undefined
);
const runtimeProbe = JSON.parse((await capture(abiProbe.command, abiProbe.args, projectRoot, {
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1"
})).trim());
assertElectronHarnessRuntime(runtimeProbe);

const pluginEntry = path.join(runtimeRoot, "node_modules", "@senguoyun", "dsh-arkme", "lib", "index.js");
await run(abiProbe.command, [
  ...abiProbe.args.slice(0, -2),
  "--input-type=module",
  "--eval",
  `await import(${JSON.stringify(pathToFileURL(pluginEntry).href)})`
], projectRoot, { ...process.env, ELECTRON_RUN_AS_NODE: "1" });

const outputDirectory = path.resolve(
  process.env.ARKME_RUNTIME_OUTPUT_DIR
  || path.join(projectRoot, "artifacts", "electron-harness", buildId)
);
const result = await buildElectronHarnessArtifacts({
  sourceModules: path.join(runtimeRoot, "node_modules"),
  output: outputDirectory,
  version: dshVersion,
  buildId
});
console.log(JSON.stringify({ outputDirectory, ...result }));

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" && command.endsWith(".cmd") });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${signal ?? `code ${code}`}`)));
  });
}

function capture(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${signal ?? `code ${code}`}: ${stderr}`)));
  });
}
