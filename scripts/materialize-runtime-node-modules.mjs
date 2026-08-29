import { cp, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function materializeRuntimeNodeModules(runtimeRoot) {
  const source = path.join(runtimeRoot, "node_modules");
  const staging = path.join(runtimeRoot, "node_modules.materialized");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  // Read the pnpm graph from the source tree, but write only concrete package
  // directories to staging. Copying .pnpm first would skip its package
  // payloads when avoiding recursive package-local node_modules links.
  await hoistVirtualStorePackages(source, staging);
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
        await copyResolvedTree(
          path.join(source, entry, scopedEntry),
          scopedDestination
        );
      }
    } else {
      await rm(destination, { recursive: true, force: true });
      await copyResolvedTree(path.join(source, entry), destination);
    }
  }
  await rm(source, { recursive: true, force: true });
  await rename(staging, source);
}

async function hoistVirtualStorePackages(sourceRoot, destinationRoot) {
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
          await copyIfMissing(source + "/" + scopedPackage, path.join(destinationRoot, entry, scopedPackage));
        }
      } else {
        await copyIfMissing(source, path.join(destinationRoot, entry));
      }
    }
  }
}

async function copyIfMissing(source, destination) {
  try {
    await lstat(destination);
  } catch {
    await copyResolvedTree(source, destination);
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
