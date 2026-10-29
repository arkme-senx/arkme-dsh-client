import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CORE_DEPENDENCY_POLICY_REVISION = "installed-core-v1";
export interface HarnessCorePackage {
  name: string;
  version: string;
  packageDir: string;
  declarer: string;
  scope: "installation";
}
export type HarnessCorePackages = Record<string, HarnessCorePackage>;

/** Only core packages actually shipped by this Harness own a shared name. */
export function readHarnessCorePackages(dshBinPath: string): HarnessCorePackages {
  const modules = path.resolve(path.dirname(dshBinPath), "../../..");
  const scope = path.join(modules, "@deepseek-ai");
  const packages: HarnessCorePackages = Object.create(null);
  for (const entry of readdirSync(scope)) {
    if (!(entry === "dsh" || entry.startsWith("dsh-") || entry === "cordis"
      || entry.startsWith("cordis-") || entry === "schemastery")) continue;
    const dir = realpathSync(path.join(scope, entry));
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const name = `@deepseek-ai/${entry}`;
    if (manifest.name !== name || typeof manifest.version !== "string") {
      throw new Error(`Invalid installed Harness core package: ${name}`);
    }
    packages[name] = {name, version: manifest.version, packageDir: dir,
      declarer: path.join(modules, "..", "package.json"), scope: "installation"};
  }
  if (packages["@deepseek-ai/dsh"] === undefined) throw new Error("Installed Harness core is missing");
  return packages;
}

/**
 * Apply the desktop policy in memory to the verified artifact. No release bytes,
 * Profile packages, lockfiles or user configuration are rewritten. The same
 * routes serve ESM, CommonJS and PluginPackages' compatibility metadata lookup.
 */
export function enforceHarnessCoreDependencies(source: string, packages: HarnessCorePackages): string {
  const marker = "/* arkme installed-core-v1 */";
  if (source.includes(marker)) return source;
  // 0.1.x fallbacks predate the runtime resolver. Keep their existing recovery
  // behavior; the policy is for the 0.2.x Harness upgrade and its successors.
  if (!source.includes("var ResolutionRouter = class")) {
    throw new Error("Harness core isolation requires a supported runtime resolver");
  }
  const replaceOnce = (from: string, to: string) => {
    if (source.split(from).length !== 2) throw new Error("Unsupported Harness core resolver layout");
    source = source.replace(from, to);
  };
  replaceOnce("routeUrl(request, parentURL) {", "routeUrl(request, parentURL) {\n\t\tconst core = arkmeCoreRoute(request);\n\t\tif (core !== void 0) return core;");
  replaceOnce("routePath(request, parent, cjs) {", "routePath(request, parent, cjs) {\n\t\tconst core = arkmeCoreRoute(request);\n\t\tif (core !== void 0) return core;");
  replaceOnce("function resolveBundleDir(binName, packageName, installAnchor, profileDir) {",
    "function resolveBundleDir(binName, packageName, installAnchor, profileDir) {\n\tif (Object.hasOwn(arkmeCorePackages, packageName)) return arkmeCorePackages[packageName].packageDir;");
  // Explicit require.resolve({paths}) must not opt a shared core out of policy.
  // Ordinary packages keep the upstream native paths behavior.
  replaceOnce("if (delegatedCjs || !parent?.filename || options?.paths !== void 0) return originalFilename.call(cjs, request, parent, main, options);",
    "if (delegatedCjs || !parent?.filename || (options?.paths !== void 0 && arkmeCoreRoute(request) === void 0)) return originalFilename.call(cjs, request, parent, main, options);");
  replaceOnce("const requirements = unmetRequirements(fields, runtimeVersion);",
    "const requirements = { ...unmetRequirements(fields, runtimeVersion), ...arkmeCoreRequirements(fields) };");
  // These declarations execute before DSH's module body and register no extra
  // resolve hooks. This preserves the upstream internal resolver's delegation.
  return `${marker}
const arkmeCorePackages = ${JSON.stringify(packages)};
function arkmeCoreRoute(request) {
  const name = barePackageName(request);
  const entry = Object.hasOwn(arkmeCorePackages, name) ? arkmeCorePackages[name] : void 0;
  return entry === void 0 ? void 0 : { route: { kind: "interception", entry, after: entry.declarer } };
}
function arkmeCoreRequirements(fields) {
  if (Object.hasOwn(arkmeCorePackages, fields.name) || fields.name === "@senguoyun/dsh-arkme") return {};
  const unmet = {};
  for (const kind of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(fields[kind] ?? {})) {
      const installed = Object.hasOwn(arkmeCorePackages, name) ? arkmeCorePackages[name] : void 0;
      if (installed === void 0) continue;
      const range = ["workspace:*", "workspace:^", "workspace:~"].includes(spec) ? installed.version : spec;
      if (typeof range !== "string" || !semver.satisfies(installed.version, range, { includePrerelease: true })) unmet[kind + "." + name] = spec;
    }
  }
  return unmet;
}
${source}`;
}

export function installHarnessCoreDependencyPolicy(dshBinPath: string): void {
  const packages = readHarnessCorePackages(dshBinPath);
  const modules = path.resolve(path.dirname(dshBinPath), "../../..");
  const appBoot = realpathSync(path.join(modules, "@deepseek-ai/dsh-app-boot/lib/index.js"));
  const version = packages["@deepseek-ai/dsh"]!.version;
  if (/^0\.1\./.test(version)) return;
  const target = pathToFileURL(appBoot).href;
  // A load-only hook keeps Node's native package exports/subpath semantics and
  // DSH's ESM/CJS interception intact. Includes worker loads via execArgv.
  registerHooks({load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== target) return result;
    if (result.source === null || result.source === undefined) throw new Error("Cannot read Harness core resolver");
    const source = typeof result.source === "string" ? result.source : Buffer.from(result.source as Uint8Array).toString("utf8");
    return {...result, source: enforceHarnessCoreDependencies(source, packages)};
  }});
  process.stderr.write(`arkme: core dependency policy ${CORE_DEPENDENCY_POLICY_REVISION} (${version})\n`);
}

const policyBin = process.env.ARKME_CORE_POLICY_BIN;
if (policyBin !== undefined && process.env.ELECTRON_RUN_AS_NODE === "1") {
  installHarnessCoreDependencyPolicy(policyBin);
}
