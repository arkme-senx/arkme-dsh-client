import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function materializeRuntimeNodeModules(runtimeRoot) {
  const source = path.join(runtimeRoot, "node_modules");
  const staging = path.join(runtimeRoot, "node_modules.materialized");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const selectedPackages = new Map();
  // Read the pnpm graph from the source tree, but write only concrete package
  // directories to staging. Copying .pnpm first would skip its package
  // payloads when avoiding recursive package-local node_modules links.
  await hoistVirtualStorePackages(source, staging, selectedPackages);
  for (const entry of await readdir(source)) {
    if (entry === ".pnpm" || entry === ".bin" || entry === ".modules.yaml") continue;
    // Direct links in the deployed root are the dependency graph selected by
    // the lockfile. They must win over same-named packages encountered while
    // flattening duplicate peer variants from .pnpm (for example dsh rc.8
    // being shadowed by an older dsh rc.7 package). Merge scoped directories
    // one child at a time so transitive packages hoisted under the same scope
    // (such as dsh-scope) are not discarded.
    const destination = path.join(staging, entry);
    if (entry.startsWith("@")) {
      for (const scopedEntry of await readdir(path.join(source, entry))) {
        const scopedDestination = path.join(destination, scopedEntry);
        await rm(scopedDestination, { recursive: true, force: true });
        await copyPackage(
          path.join(source, entry, scopedEntry),
          scopedDestination,
          selectedPackages
        );
      }
    } else {
      await rm(destination, { recursive: true, force: true });
      await copyPackage(path.join(source, entry), destination, selectedPackages);
    }
  }
  // pnpm legacy deploy leaves a backlink to the source workspace package.
  // It is not a runtime dependency: following it would copy the development
  // workspace's own dependency graph back into this standalone runtime.
  const runtimeName = await readFile(path.join(runtimeRoot, "package.json"), "utf8")
    .then(text => JSON.parse(text).name, () => undefined);
  if (typeof runtimeName === "string") {
    const backlink = path.join(staging, runtimeName);
    if (selectedPackages.has(backlink)) {
      selectedPackages.delete(backlink);
      await rm(backlink, { recursive: true, force: true });
    }
  }
  await preserveDependencyResolution(selectedPackages, staging);
  await rm(source, { recursive: true, force: true });
  await rename(staging, source);
}

async function hoistVirtualStorePackages(sourceRoot, destinationRoot, selectedPackages) {
  const virtualStore = path.join(sourceRoot, ".pnpm");
  const packageDirs = await readdir(virtualStore);
  const packageNodeModulesRoots = [path.join(virtualStore, "node_modules")];
  for (const packageDir of packageDirs) {
    if (packageDir !== "node_modules") {
      packageNodeModulesRoots.push(path.join(virtualStore, packageDir, "node_modules"));
    }
  }
  for (const packageNodeModules of packageNodeModulesRoots) {
    let entries;
    try {
      entries = await readdir(packageNodeModules);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === ".bin") continue;
      const source = path.join(packageNodeModules, entry);
      if (entry.startsWith("@")) {
        for (const scopedPackage of await readdir(source)) {
          await copyIfMissing(source + "/" + scopedPackage, path.join(destinationRoot, entry, scopedPackage), selectedPackages);
        }
      } else {
        await copyIfMissing(source, path.join(destinationRoot, entry), selectedPackages);
      }
    }
  }
}

async function copyIfMissing(source, destination, selectedPackages) {
  try {
    await lstat(destination);
  } catch {
    await copyPackage(source, destination, selectedPackages);
  }
}

async function copyPackage(source, destination, selectedPackages) {
  const actual = await realpath(source).catch(() => undefined);
  if (actual === undefined) return;
  await copyResolvedTree(actual, destination);
  selectedPackages.set(destination, actual);
}

/**
 * Flatten only dependencies that resolve to the selected package identity.
 * In particular, negotiator 1.1 needs content-type 2 while legacy consumers
 * still need content-type 1. Losing that package-local choice crashes HTTP
 * compression on the first request. Nested concrete packages preserve Node's
 * lookup rules without shipping pnpm links or escaping the runtime archive.
 */
async function preserveDependencyResolution(selectedPackages, staging) {
  const rootScope = new Map([...selectedPackages].map(([destination, source]) =>
    [path.relative(staging, destination).split(path.sep).join("/"), source]));
  const dependencyCache = new Map();
  async function dependencies(source) {
    if (dependencyCache.has(source)) return dependencyCache.get(source);
    const manifest = await readFile(path.join(source, "package.json"), "utf8")
      .then(JSON.parse, () => ({}));
    const resolved = new Map();
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
      let directory = source;
      while (true) {
        const candidate = await realpath(path.join(directory, "node_modules", name)).catch(() => undefined);
        if (candidate !== undefined) {
          resolved.set(name, candidate);
          break;
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    dependencyCache.set(source, resolved);
    return resolved;
  }
  async function preserve(source, destination, inheritedScope, ancestors) {
    const ownDependencies = await dependencies(source);
    const conflicts = [...ownDependencies].filter(([name, actual]) => inheritedScope.get(name) !== actual);
    const scope = new Map(inheritedScope);
    for (const [name, actual] of conflicts) scope.set(name, actual);
    const nextAncestors = new Set(ancestors).add(source);
    for (const [name, actual] of conflicts) {
      if (nextAncestors.has(actual)) throw new Error(`Cannot materialize cyclic dependency conflict: ${name}`);
      const nested = path.join(destination, "node_modules", name);
      await copyResolvedTree(actual, nested);
      await preserve(actual, nested, scope, nextAncestors);
    }
  }
  for (const [destination, source] of selectedPackages) {
    await preserve(source, destination, rootScope, new Set());
  }
}

async function copyResolvedTree(source, destination) {
  let actual;
  try {
    actual = await realpath(source);
  } catch {
    // Legacy pnpm deploy can leave optional/peer links dangling. They are
    // not needed when the concrete packages are hoisted below.
    return;
  }
  const info = await lstat(actual);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(actual)) {
      // Package-local node_modules is a pnpm symlink graph. Dependencies are
      // hoisted below, so traversing it here would recurse through the graph.
      if (entry === "node_modules") continue;
      await copyResolvedTree(path.join(actual, entry), path.join(destination, entry));
    }
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(actual, destination);
}
