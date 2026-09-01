import { spawn } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveLocalTestPlugin } from "./development-plugin.mjs";
import { buildSpawnOptions } from "./runtime-rebuild.mjs";

const TEST_PLUGIN_MARKER = "ARKME_TEST_PLUGIN.json";
const PRODUCTION_SIGNING_ENVIRONMENT_KEYS = [
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_ID",
  "APPLE_TEAM_ID",
  "CSC_INSTALLER_KEY_PASSWORD",
  "CSC_INSTALLER_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_LINK",
  "CSC_NAME"
];

export function buildTestPackagingCommands({
  projectRoot,
  pluginPath,
  pnpmExecutable,
  environment
}) {
  const commandEnvironment = environment === undefined ? {} : { environment };
  return [
    {
      command: pnpmExecutable,
      args: ["run", "build"],
      cwd: pluginPath,
      ...commandEnvironment
    },
    {
      command: pnpmExecutable,
      args: ["run", "build"],
      cwd: projectRoot,
      ...commandEnvironment
    },
    {
      command: process.execPath,
      args: ["scripts/prepare-runtime.mjs"],
      cwd: projectRoot,
      ...commandEnvironment
    },
    {
      command: pnpmExecutable,
      args: [
        "exec",
        "electron-builder",
        "--config",
        "electron-builder.local-test-config.cjs",
        "--mac",
        "--arm64",
        "--dir",
        "--config.directories.output=release-test",
        "--config.mac.forceCodeSigning=false"
      ],
      cwd: projectRoot,
      environment: {
        ...(environment ?? {}),
        CSC_IDENTITY_AUTO_DISCOVERY: "false"
      }
    }
  ];
}

export function buildTestAppAdHocSigningCommands({
  projectRoot,
  appPath,
  environment
}) {
  const commandEnvironment = {
    environment: {
      ...(environment ?? {}),
      CSC_IDENTITY_AUTO_DISCOVERY: "false"
    }
  };
  return [
    {
      command: "/usr/bin/codesign",
      args: ["--force", "--deep", "--sign", "-", appPath],
      cwd: projectRoot,
      ...commandEnvironment
    },
    {
      command: "/usr/bin/codesign",
      args: ["--verify", "--deep", "--strict", "--verbose=2", appPath],
      cwd: projectRoot,
      ...commandEnvironment
    }
  ];
}

export function buildTestPackagingSpawnEnvironment(
  commandEnvironment,
  inheritedEnvironment = process.env
) {
  if (commandEnvironment === undefined) return undefined;
  const environment = { ...inheritedEnvironment, ...commandEnvironment };
  if (commandEnvironment.CSC_IDENTITY_AUTO_DISCOVERY === "false") {
    for (const key of PRODUCTION_SIGNING_ENVIRONMENT_KEYS) delete environment[key];
  }
  return environment;
}

export async function writePackagedTestPluginMarker({ appPath, plugin }) {
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  await mkdir(resourcesPath, { recursive: true });
  await writeFile(
    path.join(resourcesPath, TEST_PLUGIN_MARKER),
    `${JSON.stringify({
      schemaVersion: 1,
      source: "local",
      pluginPath: plugin.path,
      packageName: "@senguoyun/dsh-arkme",
      packageVersion: plugin.version
    }, null, 2)}\n`,
    "utf8"
  );
}

export async function runTestPackaging(options) {
  const plugin = await resolveLocalTestPlugin({
    projectRoot: options.projectRoot,
    workingDirectory: options.workingDirectory,
    environment: options.environment ?? process.env,
    resolveInstalledPlugin: options.resolveInstalledPlugin ?? (() => {
      throw new Error("Test packaging requires a local Arkme plugin");
    })
  });
  const pnpmExecutable = options.pnpmExecutable
    ?? (process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  const commands = buildTestPackagingCommands({
    projectRoot: options.projectRoot,
    pluginPath: plugin.path,
    pnpmExecutable,
    environment: options.environment
  });
  const runCommand = options.runCommand ?? spawnPackagingCommand;
  const log = options.log ?? console.log;
  log(`Packaging test app with local Arkme plugin ${plugin.version} at ${plugin.path}`);

  for (const [index, command] of commands.entries()) {
    const result = await runCommand(command);
    assertPackagingCommandSucceeded(command, result);
    if (index === 0) await validateLocalPluginBuild(plugin.path);
  }

  const appPath = path.join(
    options.projectRoot,
    "release-test",
    "mac-arm64",
    "arkme Local Test.app"
  );
  await writePackagedTestPluginMarker({ appPath, plugin });
  for (const command of buildTestAppAdHocSigningCommands({
    projectRoot: options.projectRoot,
    appPath,
    environment: options.environment
  })) {
    const result = await runCommand(command);
    assertPackagingCommandSucceeded(command, result);
  }
  log(`Test app packaged at ${appPath}`);
  return { appPath, plugin };
}

function assertPackagingCommandSucceeded(command, result) {
  if (result.code === 0) return;
  throw new Error(
    `Command failed: ${command.command} ${command.args.join(" ")} `
    + `(code ${String(result.code)}, signal ${String(result.signal)})`
  );
}

async function validateLocalPluginBuild(pluginPath) {
  for (const relativePath of ["lib/index.js", "lib/client.js"]) {
    const stat = await lstat(path.join(pluginPath, relativePath));
    if (!stat.isFile()) {
      throw new Error(`Local Arkme plugin build output is not a file: ${relativePath}`);
    }
  }
}

function spawnPackagingCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: buildTestPackagingSpawnEnvironment(command.environment),
      stdio: "inherit",
      ...buildSpawnOptions({ platform: process.platform, command: command.command })
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
