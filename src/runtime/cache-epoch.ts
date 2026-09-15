import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseElectronRuntimeManifest, type ElectronRuntimeContext, type ElectronRuntimeManifest } from "./manifest.js";
import { parseRuntimeInstallState } from "./state.js";
import type { RuntimeEnvironment } from "./service-config.js";

// Increment only when installed runtime caches must be initialized again.
export const RUNTIME_CACHE_EPOCH = 1;

export function resolveRuntimeCacheRoot(userDataPath: string): string {
  return path.join(userDataPath, "runtime-manager", "electron-v1", `cache-epoch-${RUNTIME_CACHE_EPOCH}`);
}

/** Previous generations supply Code baselines only, never launchable paths. */
export async function readPreviousRuntimeBaseline(
  userDataPath: string,
  environment: RuntimeEnvironment,
  context: ElectronRuntimeContext
): Promise<ElectronRuntimeManifest | undefined> {
  const base = path.join(userDataPath, "runtime-manager", "electron-v1");
  let directories;
  try { directories = await readdir(base, { withFileTypes: true }); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  const previous = directories.flatMap(entry => {
    const match = /^cache-epoch-([1-9]\d*)$/.exec(entry.name);
    const epoch = match === null ? 0 : Number(match[1]);
    return entry.isDirectory() && epoch > 0 && epoch < RUNTIME_CACHE_EPOCH
      ? [{ root: path.join(base, entry.name), epoch }] : [];
  }).sort((a, b) => b.epoch - a.epoch);
  previous.push({ root: base, epoch: 0 });
  for (const { root } of previous) {
    const raw = await readOptionalMetadata(path.join(root, "state.json"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || !("environment" in raw) || raw.environment !== environment) continue;
    let state;
    try { state = parseRuntimeInstallState(raw, environment); }
    catch { continue; } // Optional historical metadata is never a startup dependency.
    if (state.activeReleaseId === undefined) continue;
    const document = await readOptionalMetadata(
      path.join(root, "releases", state.activeReleaseId, "release.json")
    );
    let manifest;
    try { manifest = parseElectronRuntimeManifest(document, context); }
    catch { continue; }
    if (manifest.releaseId !== state.activeReleaseId) continue;
    return manifest;
  }
  return undefined;
}

function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}


async function readOptionalMetadata(filePath: string): Promise<unknown> {
  try { return JSON.parse(await readFile(filePath, "utf8")) as unknown; }
  catch (error) {
    if (missing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
