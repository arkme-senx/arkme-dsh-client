import path from "node:path";

export function resolvePackagedSmokePlatform(args, hostPlatform = process.platform) {
  const platformFlag = args.indexOf("--platform");
  const targetPlatform = platformFlag === -1 ? hostPlatform : args[platformFlag + 1];
  if (targetPlatform !== "darwin" && targetPlatform !== "win32" && targetPlatform !== "linux") {
    throw new Error(`Unsupported packaged smoke platform: ${targetPlatform ?? "missing"}`);
  }
  if (targetPlatform !== hostPlatform) {
    throw new Error(`Cannot verify a ${targetPlatform} package on a ${hostPlatform} host`);
  }
  return targetPlatform;
}

export function resolvePackagedSmokeAppRoot(args, environmentRoot = process.env.ARKME_PACKAGED_APP_ROOT) {
  const appRootFlag = args.indexOf("--app-root");
  if (appRootFlag === -1) return environmentRoot;
  const appRoot = args[appRootFlag + 1];
  if (appRoot === undefined || appRoot.trim() === "") {
    throw new Error("Packaged smoke --app-root requires a path");
  }
  return appRoot;
}

export function packagedAppLayout(projectRoot, platform = process.platform) {
  if (platform === "win32") {
    const appRoot = path.win32.join(projectRoot, "release", "win-unpacked");
    return packagedAppLayoutFromRoot(appRoot, platform);
  }
  if (platform === "linux") {
    const appRoot = path.join(projectRoot, "release", "linux-unpacked");
    return packagedAppLayoutFromRoot(appRoot, platform);
  }
  const appRoot = path.join(projectRoot, "release", "mac-arm64", "arkme.app");
  return packagedAppLayoutFromRoot(appRoot, platform);
}

export function packagedAppLayoutFromRoot(appRoot, platform = process.platform, applicationName = "arkme") {
  const platformPath = platform === "win32" ? path.win32 : path;
  const resolvedAppRoot = platformPath.resolve(appRoot);
  const resourcesRoot = platform === "darwin"
    ? platformPath.join(resolvedAppRoot, "Contents", "Resources")
    : platformPath.join(resolvedAppRoot, "resources");
  return {
    appRoot: resolvedAppRoot,
    appAsar: platformPath.join(resourcesRoot, "app.asar"),
    electron: platform === "darwin"
      ? platformPath.join(resolvedAppRoot, "Contents", "MacOS", applicationName)
      : platformPath.join(resolvedAppRoot, platform === "win32" ? `${applicationName}.exe` : applicationName),
    resources: platformPath.join(resourcesRoot, "app.asar.unpacked")
  };
}
