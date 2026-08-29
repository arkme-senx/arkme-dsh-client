import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const POSIX_SHIM = `#!/bin/sh
if [ -z "\${ARKME_NODE_EXEC_PATH:-}" ]; then
  echo "arkme: bundled pnpm requires ARKME_NODE_EXEC_PATH" >&2
  exit 127
fi
SCRIPT_DIR=\${0%/*}
if [ "$SCRIPT_DIR" = "$0" ]; then SCRIPT_DIR=.; fi
ELECTRON_RUN_AS_NODE=1 exec "$ARKME_NODE_EXEC_PATH" "$SCRIPT_DIR/../pnpm/bin/pnpm.cjs" "$@"
`;

const POSIX_NODE_SHIM = `#!/bin/sh
if [ -z "\${ARKME_NODE_EXEC_PATH:-}" ]; then
  echo "arkme: bundled node requires ARKME_NODE_EXEC_PATH" >&2
  exit 127
fi
ELECTRON_RUN_AS_NODE=1 exec "$ARKME_NODE_EXEC_PATH" "$@"
`;

const WINDOWS_SHIM = `@echo off\r
if "%ARKME_NODE_EXEC_PATH%"=="" (\r
  echo arkme: bundled pnpm requires ARKME_NODE_EXEC_PATH 1>&2\r
  exit /b 127\r
)\r
set "ELECTRON_RUN_AS_NODE=1"\r
"%ARKME_NODE_EXEC_PATH%" "%~dp0..\\pnpm\\bin\\pnpm.cjs" %*\r
`;

const WINDOWS_NODE_SHIM = `@echo off\r
if "%ARKME_NODE_EXEC_PATH%"=="" (\r
  echo arkme: bundled node requires ARKME_NODE_EXEC_PATH 1>&2\r
  exit /b 127\r
)\r
set "ELECTRON_RUN_AS_NODE=1"\r
"%ARKME_NODE_EXEC_PATH%" %*\r
`;

async function writeShim(commandPath, content, executable) {
  const temporaryPath = `${commandPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      mode: executable ? 0o755 : 0o644,
      flag: "wx"
    });
    if (executable) await chmod(temporaryPath, 0o755);
    await rm(commandPath, { force: true });
    await rename(temporaryPath, commandPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function installBundledPnpmShim(nodeModulesPath, platform = process.platform) {
  await access(path.join(nodeModulesPath, "pnpm", "bin", "pnpm.cjs"));
  const binDirectory = path.join(nodeModulesPath, ".bin");
  await mkdir(binDirectory, { recursive: true });
  const windows = platform === "win32";
  const commandPath = path.join(binDirectory, windows ? "pnpm.cmd" : "pnpm");
  await writeShim(commandPath, windows ? WINDOWS_SHIM : POSIX_SHIM, !windows);
  await writeShim(
    path.join(binDirectory, windows ? "node.cmd" : "node"),
    windows ? WINDOWS_NODE_SHIM : POSIX_NODE_SHIM,
    !windows
  );
  return commandPath;
}

async function main() {
  const nodeModulesPath = process.argv[2];
  if (nodeModulesPath === undefined || nodeModulesPath.trim() === "") {
    throw new Error("node_modules path is required");
  }
  await installBundledPnpmShim(path.resolve(nodeModulesPath), process.argv[3] ?? process.platform);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
