import { access, readdir } from "node:fs/promises";
import path from "node:path";

export async function assertRuntimeFreeResources(resourcesPath) {
  try {
    await access(resourcesPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  assertRuntimeFreePaths(await walk(resourcesPath));
}

export function assertRuntimeFreePaths(paths) {
  for (const relativePath of paths) {
    const normalized = normalizeArchivePath(relativePath).replace(/^\/+/, "").toLowerCase();
    if (
      normalized.includes("node_modules/@deepseek-ai/dsh")
      || normalized.includes("node_modules/@senguoyun/dsh-arkme")
      || normalized === "node/bin/node"
      || normalized === "node/node.exe"
      || normalized === ".runtime"
      || normalized.startsWith(".runtime/")
    ) {
      throw new Error(`Packaged shell contains a bundled runtime path: ${relativePath}`);
    }
  }
}

export function normalizeArchivePath(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

export function resolvePackagedSmokeEnvironment(rawConfig) {
  const document = JSON.parse(Buffer.isBuffer(rawConfig) ? rawConfig.toString("utf8") : rawConfig);
  if (document.serviceBaseUrl === "https://api.jotmo.cc") {
    return { environment: "prod", userDataDirectoryName: "Arkme Harness" };
  }
  if (document.serviceBaseUrl === "https://jotmo.senguo.me") {
    return { environment: "test", userDataDirectoryName: "Arkme Harness Test" };
  }
  throw new Error(`Packaged runtime service origin is not trusted: ${String(document.serviceBaseUrl)}`);
}

async function walk(root, relative = "") {
  const paths = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    paths.push(child);
    if (entry.isDirectory()) paths.push(...await walk(root, child));
  }
  return paths;
}

export function resolvePackagedRuntimeCacheRoot(userDataPath, packagedEpochSource) {
  const matches = [...String(packagedEpochSource).matchAll(/^export const RUNTIME_CACHE_EPOCH = ([1-9]\d*);$/gm)];
  if (matches.length !== 1 || !Number.isSafeInteger(Number(matches[0][1]))) {
    throw new Error("Cannot identify the runtime cache epoch in the shipped app");
  }
  return path.join(userDataPath, "runtime-manager", "electron-v1", `cache-epoch-${matches[0][1]}`);
}

export function hasCompletedPackagedRuntimeStartup({ state, release, log }) {
  if (typeof state?.activeReleaseId !== "string" || release?.releaseId !== state.activeReleaseId
      || state.probationReleaseId !== undefined) return false;
  let completedAt = -1;
  for (const match of log.matchAll(/runtime-candidate-complete (\{[^\n]*\})/g)) {
    try { if (JSON.parse(match[1]).releaseId === state.activeReleaseId) completedAt = match.index; }
    catch { /* Incomplete final log writes are retried by the caller. */ }
  }
  if (completedAt < 0) return false;
  // Candidate completion in the shipped main process follows authenticated
  // plugin health and real hidden-page readiness. Never extract its credentials
  // or replay unauthenticated HTTP calls from this external smoke process.
  for (const match of log.matchAll(/render-ready (\{[^\n]*\})/g)) {
    if (match.index <= completedAt) continue;
    try {
      const url = new URL(JSON.parse(match[1]).url);
      if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port
          && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/") return true;
    } catch { /* Ignore partial or invalid events. */ }
  }
  return false;
}
