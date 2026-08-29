import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { extractFile } from "@electron/asar";
import {
  assertPackagedShellEnvironment,
  resolvePackagedShell
} from "./packaged-shell-lib.mjs";

const environment = process.argv[2];
const shell = resolvePackagedShell(process.cwd(), environment, process.platform);

try {
  await Promise.all([access(shell.appAsar), access(shell.executable)]);
} catch (cause) {
  throw new Error(
    `${shell.applicationName} packaged shell is unavailable at ${shell.appRoot}. Build it with: ${shell.buildCommand}`,
    { cause }
  );
}

assertPackagedShellEnvironment(
  extractFile(shell.appAsar, "dist/runtime-service-config.json"),
  shell.environment
);

console.log(`Starting ${shell.applicationName} (${shell.environment}) from ${shell.appRoot}`);
const exit = await launch(shell.executable);
if (exit.code !== 0) {
  throw new Error(
    `${shell.applicationName} exited with code ${String(exit.code)} and signal ${String(exit.signal)}`
  );
}

function launch(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
