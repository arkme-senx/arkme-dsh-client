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
