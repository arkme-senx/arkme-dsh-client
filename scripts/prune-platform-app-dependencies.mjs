import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function incompatibleShellNativeDependencyPaths(
  root,
  platform = process.platform
) {
  return platform === "darwin"
    ? []
    : [path.join(root, "node_modules", "@arkme", "macos-notification-permission")];
}

export async function pruneIncompatibleShellNativeDependencies(
  root = projectRoot,
  platform = process.platform
) {
  await Promise.all(incompatibleShellNativeDependencyPaths(root, platform).map(
    dependencyPath => rm(dependencyPath, { recursive: true, force: true })
  ));
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  await pruneIncompatibleShellNativeDependencies();
}
