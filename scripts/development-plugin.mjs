import { spawn } from "node:child_process";
import { access, lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { buildSpawnOptions } from "./runtime-rebuild.mjs";

const PLUGIN_NAME = "@senguoyun/dsh-arkme";
const PLUGIN_PATCH = "./cordis.patch.yml";
const PLUGIN_SOURCE_INPUTS = ["cordis.patch.yml"];
const PLUGIN_BUILD_OUTPUTS = ["lib/index.js", "lib/client.js"];

/**
 * @param {{ projectRoot: string, workingDirectory: string, environment: Record<string, string | undefined>, resolveInstalledPlugin: () => string | Promise<string> }} options
 */
export async function resolveDevelopmentPlugin(options) {
  const configuredPath = options.environment.ARKME_PLUGIN_PATH?.trim();
  if (configuredPath) {
    const pluginPath = path.resolve(options.workingDirectory, configuredPath);
    if (!await pathExists(pluginPath)) {
      throw new Error(`ARKME_PLUGIN_PATH points to an invalid plugin: ${pluginPath}`);
    }
    return {
      path: pluginPath,
      source: "local",
      version: await validateLocalPlugin(pluginPath)
    };
  }

  const siblingPlugin = path.resolve(options.projectRoot, "..", "arkme-dsh-plugin");
  if (await pathExists(siblingPlugin)) {
    return {
      path: siblingPlugin,
      source: "local",
      version: await validateLocalPlugin(siblingPlugin)
    };
  }

  const pluginPath = await options.resolveInstalledPlugin();
  return {
    path: pluginPath,
    source: "production",
    version: await validateProductionPlugin(pluginPath)
  };
}

export async function resolveLocalTestPlugin(options) {
  const plugin = await resolveDevelopmentPlugin(options);
  if (plugin.source !== "local") {
    throw new Error("Test packaging requires a local Arkme plugin");
  }
  return plugin;
}

/**
 * @param {{ projectRoot: string, environment?: Record<string, string>, plugin: { path: string, source: "local" | "production", version: string }, pnpmExecutable: string, electronExecutable: string }} options
 */
export function buildDevelopmentCommands(options) {
  const commands = [];
  const environment = options.environment === undefined
    ? {}
    : { environment: options.environment };
  if (options.plugin.source === "local") {
    commands.push({
      command: options.pnpmExecutable,
      args: ["run", "build"],
      cwd: options.plugin.path,
      ...environment
    });
  }
  commands.push(
    {
      command: options.pnpmExecutable,
      args: ["exec", "tsc", "-p", "tsconfig.build.json"],
      cwd: options.projectRoot,
      ...environment
    },
    {
      command: process.execPath,
      args: ["scripts/copy-static.mjs"],
      cwd: options.projectRoot,
      ...environment
    },
    {
      command: options.electronExecutable,
      args: ["."],
      cwd: options.projectRoot,
      ...(options.plugin.source === "local" ? {
        environment: {
          ...withoutUndefinedValues(options.environment ?? process.env),
          ARKME_PLUGIN_PATH: options.plugin.path
        }
      } : environment)
    }
  );
  return commands;
}

/**
 * @param {{ projectRoot: string, workingDirectory: string, environment?: Record<string, string | undefined>, resolveInstalledPlugin?: () => string | Promise<string>, pnpmExecutable?: string, electronExecutable: string, platform?: NodeJS.Platform, runCommand?: (command: { command: string, args: readonly string[], cwd: string, environment?: Record<string, string> }) => Promise<{ code: number | null, signal: NodeJS.Signals | null }>, log?: (message: string) => void }} options
 */
export async function runDevelopment(options) {
  const platform = options.platform ?? process.platform;
  const resolutionEnvironment = options.environment ?? process.env;
  const plugin = await resolveDevelopmentPlugin({
    projectRoot: options.projectRoot,
    workingDirectory: options.workingDirectory,
    environment: resolutionEnvironment,
    resolveInstalledPlugin: options.resolveInstalledPlugin ?? resolveInstalledPlugin
  });
  const pnpmExecutable = options.pnpmExecutable ?? (platform === "win32" ? "pnpm.cmd" : "pnpm");
  const commands = buildDevelopmentCommands({
    projectRoot: options.projectRoot,
    environment: options.environment === undefined
      ? undefined
      : withoutUndefinedValues(options.environment),
    plugin,
    pnpmExecutable,
    electronExecutable: options.electronExecutable
  });
  const runCommand = options.runCommand ?? ((command) => spawnDevelopmentCommand(command, platform));

  const log = options.log ?? console.log;
  log(`Using ${plugin.source} Arkme plugin ${plugin.version} at ${plugin.path}`);
  for (const [index, command] of commands.entries()) {
    const result = await runCommand(command);
    if (result.code !== 0) {
      throw new Error(
        `Command failed: ${command.command} ${command.args.join(" ")} (code ${String(result.code)}, signal ${String(result.signal)})`
      );
    }
    if (plugin.source === "local" && index === 0) {
      await validatePluginBuildOutputs(plugin.path);
    }
  }
}

async function validateLocalPlugin(pluginPath) {
  const { manifest, version } = await validatePluginSource(pluginPath);
  if (typeof manifest.scripts?.build !== "string" || manifest.scripts.build.trim() === "") {
    throw new Error(`Invalid Arkme plugin at ${pluginPath}`);
  }
  return version;
}

async function validateProductionPlugin(pluginPath) {
  const { version } = await validatePluginSource(pluginPath);
  await validatePluginBuildOutputs(pluginPath);
  return version;
}

async function validatePluginSource(pluginPath) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(pluginPath, "package.json"), "utf8"));
  } catch {
    throw new Error(`Invalid Arkme plugin at ${pluginPath}`);
  }
  const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  if (
    manifest.name !== PLUGIN_NAME ||
    version === "" ||
    manifest.dsh?.bundle?.patch !== PLUGIN_PATCH
  ) {
    throw new Error(`Invalid Arkme plugin at ${pluginPath}`);
  }
  await validateRegularFiles(pluginPath, PLUGIN_SOURCE_INPUTS);
  return { manifest, version };
}

async function validatePluginBuildOutputs(pluginPath) {
  await validateRegularFiles(pluginPath, PLUGIN_BUILD_OUTPUTS);
}

async function validateRegularFiles(pluginPath, relativePaths) {
  for (const relativePath of relativePaths) {
    let stat;
    try {
      stat = await lstat(path.join(pluginPath, relativePath));
    } catch (cause) {
      throw new Error(
        `Invalid Arkme plugin at ${pluginPath}: required file is unavailable: ${relativePath}`,
        { cause }
      );
    }
    if (!stat.isFile()) {
      throw new Error(
        `Invalid Arkme plugin at ${pluginPath}: required path is not a regular file: ${relativePath}`
      );
    }
  }
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveInstalledPlugin() {
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve("@senguoyun/dsh-arkme/package.json"));
}

function withoutUndefinedValues(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
}

function spawnDevelopmentCommand(command, platform) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: command.environment,
      stdio: "inherit",
      ...buildSpawnOptions({ platform, command: command.command })
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
