import path from "node:path";
import { packagedAppLayoutFromRoot } from "./packaged-layout.mjs";
import { resolvePackagedSmokeEnvironment } from "./packaged-smoke-lib.mjs";

const ENVIRONMENTS = {
  prod: {
    applicationName: "arkme",
    outputDirectory: "release"
  },
  test: {
    applicationName: "arkme Test",
    outputDirectory: "release-test-dynamic"
  }
};

export function resolvePackagedShell(projectRoot, environment, platform = process.platform) {
  const config = ENVIRONMENTS[environment];
  if (config === undefined) {
    throw new Error(`Packaged shell environment must be prod or test: ${String(environment)}`);
  }
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
    throw new Error(`Unsupported packaged shell platform: ${platform}`);
  }
  const platformPath = platform === "win32" ? path.win32 : path;
  const appRoot = platform === "darwin"
    ? platformPath.join(projectRoot, config.outputDirectory, "mac-universal", `${config.applicationName}.app`)
    : platformPath.join(
      projectRoot,
      config.outputDirectory,
      platform === "win32" ? "win-unpacked" : "linux-unpacked"
    );
  const layout = packagedAppLayoutFromRoot(appRoot, platform, config.applicationName);
  return {
    environment,
    applicationName: config.applicationName,
    appRoot: layout.appRoot,
    appAsar: layout.appAsar,
    executable: layout.electron,
    buildCommand: buildCommand(environment, platform)
  };
}

export function assertPackagedShellEnvironment(rawConfig, expectedEnvironment) {
  const actual = resolvePackagedSmokeEnvironment(rawConfig).environment;
  if (actual !== expectedEnvironment) {
    throw new Error(`Refusing to start ${actual} package through run:${expectedEnvironment}`);
  }
  return actual;
}

function buildCommand(environment, platform) {
  if (environment === "test") {
    return platform === "darwin"
      ? "pnpm dist:test:mac"
      : platform === "win32"
        ? "pnpm dist:test:win"
        : "pnpm dist:test:linux";
  }
  return platform === "darwin"
    ? "pnpm pack"
    : platform === "win32"
      ? "pnpm dist:win"
      : "pnpm dist:linux";
}
