import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_PLUGIN_MARKER = "ARKME_TEST_PLUGIN.json";

export function packagedDshBinPath(resourcesPath: string): string {
  return path.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "lib",
    "bin.js"
  );
}

export function packagedArkmePluginPath(resourcesPath: string): string {
  return path.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@senguoyun",
    "dsh-arkme"
  );
}

export function packagedPnpmBinDirectory(resourcesPath: string): string {
  return path.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    ".bin"
  );
}

export function developmentPnpmBinDirectory(fromModuleUrl: string): string {
  return path.join(
    path.dirname(fileURLToPath(fromModuleUrl)),
    "..",
    "runtime",
    "node_modules",
    ".bin"
  );
}

export async function readPackagedTestPluginPath(
  resourcesPath: string
): Promise<string | undefined> {
  try {
    const marker = JSON.parse(
      await readFile(path.join(resourcesPath, TEST_PLUGIN_MARKER), "utf8")
    ) as { schemaVersion?: unknown; source?: unknown; pluginPath?: unknown };
    if (
      marker.schemaVersion !== 1
      || marker.source !== "local"
      || typeof marker.pluginPath !== "string"
      || !path.isAbsolute(marker.pluginPath)
    ) {
      throw new Error("Invalid packaged test plugin marker");
    }
    return marker.pluginPath;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function developmentDshBinPath(fromModuleUrl: string): string {
  const require = createRequire(fromModuleUrl);
  const manifestPath = require.resolve("@deepseek-ai/dsh/package.json");
  return path.join(path.dirname(manifestPath), "lib", "bin.js");
}

export function developmentArkmePluginPath(
  fromModuleUrl: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const configuredPath = environment.ARKME_PLUGIN_PATH?.trim();
  if (configuredPath !== undefined && configuredPath !== "") {
    return path.resolve(configuredPath);
  }
  const require = createRequire(fromModuleUrl);
  const manifestPath = require.resolve("@senguoyun/dsh-arkme/package.json");
  return path.dirname(manifestPath);
}

export function resolveDshBinPath(
  isPackaged: boolean,
  resourcesPath: string,
  fromModuleUrl: string
): string {
  return isPackaged
    ? packagedDshBinPath(resourcesPath)
    : developmentDshBinPath(fromModuleUrl);
}

export function resolveArkmePluginPath(
  isPackaged: boolean,
  resourcesPath: string,
  fromModuleUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
  packagedTestPluginPath?: string
): string {
  return isPackaged
    ? packagedTestPluginPath ?? packagedArkmePluginPath(resourcesPath)
    : developmentArkmePluginPath(fromModuleUrl, environment);
}

export function resolveManagedExtensionRestartPaths(
  arkmePluginPath: string,
  dshHome: string,
  releaseId?: string
): { helperPath: string; planPath: string; releaseId?: string } {
  return {
    helperPath: path.join(arkmePluginPath, "lib", "extension-profile-restart-helper.js"),
    planPath: path.join(dshHome, "arkme-self", "desktop-managed-extension-restart.json"),
    ...(releaseId === undefined ? {} : { releaseId })
  };
}

export function resolvePnpmBinDirectory(
  isPackaged: boolean,
  resourcesPath: string,
  fromModuleUrl: string
): string {
  return isPackaged
    ? packagedPnpmBinDirectory(resourcesPath)
    : developmentPnpmBinDirectory(fromModuleUrl);
}

export async function resolveArkmePluginPathForLaunch(
  isPackaged: boolean,
  resourcesPath: string,
  fromModuleUrl: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const packagedTestPluginPath = isPackaged
    ? await readPackagedTestPluginPath(resourcesPath)
    : undefined;
  return resolveArkmePluginPath(
    isPackaged,
    resourcesPath,
    fromModuleUrl,
    environment,
    packagedTestPluginPath
  );
}
