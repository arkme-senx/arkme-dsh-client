import { createHash } from "node:crypto";
import { cp, lstat, readFile, readdir, rm, mkdir } from "node:fs/promises";
import path from "node:path";

export function assertRuntimePluginReady(manifest) {
  if (manifest?.arkme?.desktopHarnessReady?.version !== 1) {
    throw new Error("Runtime seed lacks arkme.desktopHarnessReady.version=1; publish and pin the reviewed readiness plugin before a production build, or use ARKME_RUNTIME_LOCAL_PLUGIN_DIR for a local candidate");
  }
}

async function treeDigest(root, relative = "", hash = createHash("sha256")) {
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const child = path.join(relative, name);
    const info = await lstat(path.join(root, child));
    if (info.isSymbolicLink()) throw new Error(`Local runtime plugin must not contain symlinks: ${child}`);
    if (info.isDirectory()) await treeDigest(root, child, hash);
    else if (info.isFile()) {
      const bytes = await readFile(path.join(root, child));
      hash.update(JSON.stringify([child.split(path.sep).join("/"), info.mode & 0o777, bytes.length]));
      hash.update(bytes);
    } else throw new Error(`Local runtime plugin must contain ordinary files: ${child}`);
  }
  return hash;
}

export async function stageLocalRuntimePlugin({ localPluginDir, pluginDir }) {
  const localRoot = path.resolve(localPluginDir);
  if (localRoot === path.resolve(pluginDir)) throw new Error("Local plugin source must differ from staging destination");
  const manifest = JSON.parse(await readFile(path.join(localRoot, "package.json"), "utf8"));
  assertRuntimePluginReady(manifest);
  if (manifest.name !== "@senguoyun/dsh-arkme") throw new Error("Local runtime plugin has the wrong package name");
  // Copy only the package's declared publication roots; never node_modules or
  // the Git checkout. Preserve the actual package version and built bytes.
  const roots = new Set(["package.json", ...(manifest.files ?? []).map(file => file.split("/")[0])]);
  for (const root of roots) {
    if (!/^[A-Za-z0-9_.-]+$/.test(root) || root === "." || root === ".." || root === "node_modules" || root.startsWith(".git")) {
      throw new Error(`Unsupported local plugin publication root: ${root}`);
    }
  }
  await rm(pluginDir, { recursive: true, force: true });
  await mkdir(pluginDir, { recursive: true });
  for (const root of roots) await cp(path.join(localRoot, root), path.join(pluginDir, root), { recursive: true, dereference: false });
  // Fingerprint the copied source snapshot; the seed manifest separately hashes
  // the final packed bytes after routine runtime pruning.
  const contentSha256 = (await treeDigest(pluginDir)).digest("hex");
  return { kind: "local", packageName: manifest.name, packageVersion: manifest.version, contentSha256 };
}
