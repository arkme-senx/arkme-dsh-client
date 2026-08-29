import path from "node:path";

export const arkmeDesktopCapabilities = Object.freeze({
  startupAuthGate: true as const,
  appUpdate: true as const,
  runtimeManaged: true as const
});

export function resolveArkmePreloadPath(
  moduleDirectory: string,
  isPackaged = false,
  resourcesPath = ""
): string {
  if (isPackaged) {
    return path.join(resourcesPath, "app.asar.unpacked", "dist", "preload.cjs");
  }
  return path.join(moduleDirectory, "preload.cjs");
}
