import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { CORE_DEPENDENCY_POLICY_REVISION, readHarnessCorePackages, type HarnessCorePackages } from "./harness-core-dependencies.js";

export function coreDependencyConflicts(value: unknown, core: HarnessCorePackages): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["invalid plugin manifest"];
  const manifest = value as {name?: string; engines?: Record<string, unknown>; dependencies?: Record<string, unknown>;
    peerDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown>};
  if (typeof manifest.name === "string" && (Object.hasOwn(core, manifest.name) || manifest.name === "@senguoyun/dsh-arkme")) return [];
  const conflicts: string[] = [];
  const runtimeVersion = core["@deepseek-ai/dsh"]!.version;
  const engine = manifest.engines?.dsh;
  if (engine !== undefined && (typeof engine !== "string" || !semver.satisfies(runtimeVersion, engine, {includePrerelease: true}))) {
    conflicts.push(`engines.dsh=${String(engine)}`);
  }
  for (const kind of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const [name, spec] of Object.entries(manifest[kind] ?? {})) {
      const installed = Object.hasOwn(core, name) ? core[name] : undefined;
      if (installed === undefined) continue;
      const range = ["workspace:*", "workspace:^", "workspace:~"].includes(String(spec)) ? installed.version : spec;
      if (typeof range !== "string" || !semver.satisfies(installed.version, range, {includePrerelease: true})) {
        conflicts.push(`${kind}.${name}=${String(spec)} (installed ${installed.version})`);
      }
    }
  }
  return conflicts;
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
interface DependencyManifest {file: string; raw: string; manifest: unknown;}

/** Metadata-only traversal: never import third-party code while deciding isolation. */
async function dependencyManifests(directories: string[], ownsCore: (name: string) => boolean = () => false): Promise<DependencyManifest[]> {
  const pending = [...directories].sort().reverse();
  const visited = new Set<string>();
  const result: DependencyManifest[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const canonical = await realpath(directory).catch(() => directory);
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    const file = path.join(canonical, "package.json");
    let raw: string;
    try { raw = await readFile(file, "utf8"); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Resource/permission failures do not authorize disabling valid plugins.
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      result.push({file, raw: `unreadable:${code}`, manifest: null});
      continue;
    }
    let manifest: unknown;
    try { manifest = JSON.parse(raw); } catch { manifest = null; }
    result.push({file, raw, manifest});
    const fields = object(manifest);
    const names = Object.keys({...object(fields.dependencies), ...object(fields.optionalDependencies)}).sort().reverse();
    for (const name of names) {
      // These are supplied by Harness, including old copies left in the Profile.
      if (!PACKAGE_NAME.test(name) || ownsCore(name) || name === "@senguoyun/dsh-arkme") continue;
      for (const base of createRequire(file).resolve.paths(name) ?? []) {
        const candidate = path.join(base, name);
        if (await readFile(path.join(candidate, "package.json")).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT")) {
          pending.push(candidate);
          break;
        }
      }
    }
  }
  return result;
}

/** Only selected optional bundles may be quarantined, never a core service. */
export async function incompatibleProfileCorePackages(dshHome: string, dshBinPath: string): Promise<string[]> {
  const core = readHarnessCorePackages(dshBinPath);
  if (/^0\.1\./.test(core["@deepseek-ai/dsh"]!.version)) return [];
  const profile = path.join(dshHome, "profiles/web");
  const manifest = JSON.parse(await readFile(path.join(profile, "package.json"), "utf8"));
  const incompatible: string[] = [];
  for (const name of manifest.dsh?.profile?.bundles ?? []) {
    if (typeof name !== "string" || name.startsWith("@deepseek-ai/") || name === "@senguoyun/dsh-arkme"
      || typeof manifest.dependencies?.[name] !== "string" || !PACKAGE_NAME.test(name)) continue;
    const graph = await dependencyManifests([path.join(profile, "node_modules", name)], dependency => Object.hasOwn(core, dependency));
    if (graph.some(node => {
      const fields = object(node.manifest);
      // An npm alias can carry an old core under an ordinary dependency name.
      const aliasedCore = typeof fields.name === "string" && Object.hasOwn(core, fields.name)
        && fields.version !== core[fields.name]!.version;
      return aliasedCore || coreDependencyConflicts(node.manifest, core).length > 0;
    })) incompatible.push(name);
  }
  return incompatible;
}

/** Stable across launches; health timestamps and the managed plugin link are not inputs. */
export async function profileCoreRecoveryKey(userDataPath: string): Promise<string> {
  const homes = [path.join(userDataPath, "dsh")];
  try {
    for (const entry of (await readdir(path.join(userDataPath, "dsh-containers"), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) homes.push(path.join(userDataPath, "dsh-containers", entry.name, "dsh"));
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const hash = createHash("sha256").update(CORE_DEPENDENCY_POLICY_REVISION);
  for (const home of homes) {
    const profile = path.join(home, "profiles/web");
    let raw: string;
    try { raw = await readFile(path.join(profile, "package.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    let manifest;
    try { manifest = JSON.parse(raw); }
    catch { hash.update(JSON.stringify([home, raw])); continue; }
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      hash.update(JSON.stringify([home, raw])); continue;
    }
    const dependencies = Object.entries(object(manifest.dependencies)).filter(([name]) => name !== "@senguoyun/dsh-arkme").sort(([a], [b]) => a.localeCompare(b));
    hash.update(JSON.stringify([home, dependencies, manifest.dsh?.profile?.bundles]));
    const graph = await dependencyManifests(dependencies.filter(([name]) => PACKAGE_NAME.test(name))
      .map(([name]) => path.join(profile, "node_modules", name)));
    for (const node of graph) hash.update(JSON.stringify([node.file, node.raw]));
    try { hash.update(await readFile(path.join(profile, "cordis.patch.yml"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return hash.digest("hex");
}
