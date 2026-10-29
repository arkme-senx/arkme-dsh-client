import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, expect, test } from "vitest";
import { enforceHarnessCoreDependencies, readHarnessCorePackages } from "../src/harness-core-dependencies.js";
import { coreDependencyConflicts, incompatibleProfileCorePackages, profileCoreRecoveryKey } from "../src/profile-core-compatibility.js";
import { activateOptionalExtensionRecovery, enforceActiveOptionalExtensionRecoveries, prepareOptionalExtensionRecovery, restoreOptionalExtensionRecovery } from "../src/optional-extension-recovery.js";
import { patchDshProfileBundleResolution } from "../scripts/patch-dsh-profile-bundle-resolution.mjs";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });
async function pkg(dir: string, name: string, version: string, extra: object = {}) {
  await mkdir(dir, {recursive: true});
  await writeFile(path.join(dir, "package.json"), JSON.stringify({name, version, ...extra}));
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "arkme core migration with spaces-")); roots.push(root);
  const modules = path.join(root, "harness/node_modules");
  const dsh = path.join(modules, "@deepseek-ai/dsh");
  const dshBinPath = path.join(dsh, "lib/bin.js");
  await pkg(dsh, "@deepseek-ai/dsh", "0.2.1-rc.2");
  const llm = path.join(modules, "@deepseek-ai/dsh-llm");
  await pkg(llm, "@deepseek-ai/dsh-llm", "0.2.1-rc.2", {type: "module", exports: {".": {import: "./index.js", require: "./index.cjs"}, "./package.json": "./package.json"}});
  await writeFile(path.join(llm, "index.js"), 'export const version = "new-core";');
  await writeFile(path.join(llm, "index.cjs"), 'exports.version = "new-core";');
  const home = path.join(root, "user/dsh");
  const profile = path.join(home, "profiles/web");
  await mkdir(profile, {recursive: true});
  const manifest = {name: "profile", dependencies: {"dsh-llm-codex": "0.1.2", "good-extension": "1.0.0", "@deepseek-ai/dsh-llm": "0.1.0-rc.6"},
    dsh: {profile: {bundles: ["dsh-llm-codex", "good-extension"]}}};
  await writeFile(path.join(profile, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(profile, "cordis.patch.yml"), "[]\n");
  await pkg(path.join(profile, "node_modules/dsh-llm-codex"), "dsh-llm-codex", "0.1.2", {dependencies: {"@deepseek-ai/dsh-llm": "0.1.0-rc.6"}, dsh: {bundle: {patch: "./cordis.patch.yml"}}});
  await writeFile(path.join(profile, "node_modules/dsh-llm-codex/cordis.patch.yml"), "[]\n");
  await pkg(path.join(profile, "node_modules/good-extension"), "good-extension", "1.0.0", {dependencies: {"@deepseek-ai/dsh-llm": "^0.2.0"}, dsh: {bundle: {patch: "./cordis.patch.yml"}}});
  await writeFile(path.join(profile, "node_modules/good-extension/cordis.patch.yml"), "[]\n");
  const old = path.join(profile, "node_modules/@deepseek-ai/dsh-llm");
  await pkg(old, "@deepseek-ai/dsh-llm", "0.1.0-rc.6", {type: "module", exports: {".": {import: "./index.js", require: "./index.cjs"}}});
  await writeFile(path.join(old, "index.js"), 'export const version = "old-core";');
  await writeFile(path.join(old, "index.cjs"), 'exports.version = "old-core";');
  return {root, modules, dshBinPath, home, profile, llm, old};
}

test("migrates a legacy Profile by quarantining incompatible bundles without removing their dependencies or user data", async () => {
  const f = await fixture();
  const before = await readFile(path.join(f.profile, "package.json"), "utf8");
  const core = readHarnessCorePackages(f.dshBinPath);
  expect(coreDependencyConflicts({name: "constructor", dependencies: {"@deepseek-ai/dsh-llm": "0.1.0-rc.6"}}, core)).toHaveLength(1);
  expect(coreDependencyConflicts({name: "extension", peerDependencies: {"@deepseek-ai/dsh-llm": "^0.1.0"}}, core)).toHaveLength(1);
  expect(coreDependencyConflicts({name: "extension", engines: {dsh: "^0.1.0"}}, core)).toHaveLength(1);
  expect(coreDependencyConflicts({name: "extension", optionalDependencies: {"@deepseek-ai/dsh-llm": "0.1.0-rc.6"}}, core)).toHaveLength(1);
  const incompatible = await incompatibleProfileCorePackages(f.home, f.dshBinPath);
  expect(incompatible).toEqual(["dsh-llm-codex"]);
  const transaction = await prepareOptionalExtensionRecovery({dshHome: f.home, environment: "prod", failureText: "core preflight", incompatiblePackages: incompatible});
  expect(transaction).toBeDefined();
  expect(await incompatibleProfileCorePackages(f.home, f.dshBinPath)).toEqual([]);
  expect(JSON.parse(await readFile(path.join(f.profile, "package.json"), "utf8")).dependencies).toEqual(JSON.parse(before).dependencies);
  expect(JSON.parse(await readFile(path.join(f.old, "package.json"), "utf8")).version).toBe("0.1.0-rc.6");
  // Failed trial restores the exact original bytes, including extension order.
  await restoreOptionalExtensionRecovery(transaction!);
  expect(await readFile(path.join(f.profile, "package.json"), "utf8")).toBe(before);
  const resumed = await prepareOptionalExtensionRecovery({dshHome: f.home, environment: "prod", failureText: "core preflight", incompatiblePackages: incompatible});
  await writeFile(path.join(f.profile, "package.json"), before);
  expect(await enforceActiveOptionalExtensionRecoveries({dshHome: f.home, environment: "prod"})).toEqual([]);
  // An extension restart-plan rollback must not silently re-enable this trial's quarantine.
  expect(await enforceActiveOptionalExtensionRecoveries({dshHome: f.home, environment: "prod"}, {pendingQuarantineId: resumed!.receipt.quarantineId})).toEqual(["dsh-llm-codex"]);
  await activateOptionalExtensionRecovery(resumed!);
  await writeFile(path.join(f.profile, "package.json"), before);
  expect(await enforceActiveOptionalExtensionRecoveries({dshHome: f.home, environment: "prod"})).toEqual(["dsh-llm-codex"]);
  expect(await incompatibleProfileCorePackages(f.home, f.dshBinPath)).toEqual([]);
  expect(await prepareOptionalExtensionRecovery({dshHome: f.home, environment: "prod", failureText: "core", incompatiblePackages: ["@deepseek-ai/dsh-llm"]})).toBeUndefined();
});

test("quarantines Codex and a legacy local bundle together while preserving the compatible bundle", async () => {
  const f = await fixture();
  const file = path.join(f.profile, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.dependencies["dsh-arkme-decision-mirror"] = "file:D:/workspace/decision-mirror.tgz";
  manifest.dsh.profile.bundles.push("dsh-arkme-decision-mirror");
  await writeFile(file, JSON.stringify(manifest));
  await pkg(path.join(f.profile, "node_modules/dsh-arkme-decision-mirror"), "dsh-arkme-decision-mirror", "1.0.0", {peerDependencies: {"@deepseek-ai/dsh-llm": "^0.1.0-rc.5"}});
  const names = await incompatibleProfileCorePackages(f.home, f.dshBinPath);
  expect(names).toEqual(["dsh-llm-codex", "dsh-arkme-decision-mirror"]);
  const transaction = await prepareOptionalExtensionRecovery({dshHome: f.home, environment: "prod", incompatiblePackages: names, failureText: "core preflight"});
  expect(transaction!.receipt.entries).toHaveLength(2);
  expect(JSON.parse(await readFile(file, "utf8")).dsh.profile.bundles).toEqual(["good-extension"]);
  await activateOptionalExtensionRecovery(transaction!);
});

test("recovery key ignores health timestamps but changes when a legacy plugin is upgraded in place", async () => {
  const f = await fixture();
  const user = path.dirname(f.home);
  const key = await profileCoreRecoveryKey(user);
  const file = path.join(f.profile, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.arkme = {managedPlugin: {lastHealthCheck: {checkedAtMillis: Date.now()}}};
  await writeFile(file, JSON.stringify(manifest));
  expect(await profileCoreRecoveryKey(user)).toBe(key);
  await pkg(path.join(f.profile, "node_modules/dsh-llm-codex"), "dsh-llm-codex", "0.2.0", {dependencies: {"@deepseek-ai/dsh-llm": "^0.2.0"}});
  expect(await profileCoreRecoveryKey(user)).not.toBe(key);
  expect(await incompatibleProfileCorePackages(f.home, f.dshBinPath)).toEqual([]);
});

test("finds transitive core conflicts and detects a nested repair without executing plugins", async () => {
  const f = await fixture();
  const plugin = path.join(f.profile, "node_modules/dsh-llm-codex");
  const adapter = path.join(plugin, "node_modules/codex-adapter");
  await pkg(plugin, "dsh-llm-codex", "0.1.2", {dependencies: {"codex-adapter": "1.0.0"}});
  await pkg(adapter, "codex-adapter", "1.0.0", {dependencies: {"@deepseek-ai/dsh-llm": "0.1.0-rc.6", "dsh-llm-codex": "0.1.2"}});
  expect(await incompatibleProfileCorePackages(f.home, f.dshBinPath)).toEqual(["dsh-llm-codex"]);
  const key = await profileCoreRecoveryKey(path.dirname(f.home));
  await pkg(adapter, "codex-adapter", "1.0.0", {dependencies: {"@deepseek-ai/dsh-llm": "^0.2.0", "dsh-llm-codex": "0.1.2"}});
  expect(await incompatibleProfileCorePackages(f.home, f.dshBinPath)).toEqual([]);
  expect(await profileCoreRecoveryKey(path.dirname(f.home))).not.toBe(key);
  await pkg(adapter, "codex-adapter", "1.0.0", {dependencies: {"old-llm-alias": "npm:@deepseek-ai/dsh-llm@0.1.0-rc.6"}});
  await pkg(path.join(adapter, "node_modules/old-llm-alias"), "@deepseek-ai/dsh-llm", "0.1.0-rc.6");
  expect(await incompatibleProfileCorePackages(f.home, f.dshBinPath)).toEqual(["dsh-llm-codex"]);
});

test("corrupt disabled plugin and dormant Profile metadata cannot block all upgrade retries", async () => {
  const f = await fixture();
  const user = path.dirname(f.home);
  await writeFile(path.join(f.profile, "node_modules/dsh-llm-codex/package.json"), "{broken");
  const dormant = path.join(user, "dsh-containers/account-b/dsh/profiles/web");
  await mkdir(dormant, {recursive: true});
  await writeFile(path.join(dormant, "package.json"), "{also broken");
  const key = await profileCoreRecoveryKey(user);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(await incompatibleProfileCorePackages(f.home, f.dshBinPath)).toEqual(["dsh-llm-codex"]);
  await pkg(path.join(f.profile, "node_modules/dsh-llm-codex"), "dsh-llm-codex", "0.2.0");
  expect(await profileCoreRecoveryKey(user)).not.toBe(key);
});

test("published 0.2.1 resolver uses installed core for ESM, CommonJS and metadata even with a disabled plugin and nested old copies", async () => {
  const f = await fixture();
  const realModules = path.resolve("node_modules");
  for (const entry of await readdir(realModules)) {
    if (entry === "@deepseek-ai" || entry.startsWith(".")) continue;
    await symlink(path.join(realModules, entry), path.join(f.modules, entry), "junction");
  }
  for (const entry of await readdir(path.join(realModules, "@deepseek-ai"))) {
    if (["dsh", "dsh-llm", "dsh-app-boot"].includes(entry)) continue;
    await symlink(path.join(realModules, "@deepseek-ai", entry), path.join(f.modules, "@deepseek-ai", entry), "junction");
  }
  // pnpm keeps app-boot's transitive imports in its own virtual-store scope.
  const installedRequire = createRequire(await realpath(path.join(realModules, "@deepseek-ai/dsh/package.json")));
  const bootRequire = createRequire(installedRequire.resolve("@deepseek-ai/dsh-app-boot"));
  const installedBoot = path.resolve(path.dirname(installedRequire.resolve("@deepseek-ai/dsh-app-boot")), "..");
  const bootManifest = JSON.parse(await readFile(path.join(installedBoot, "package.json"), "utf8"));
  for (const name of Object.keys({...bootManifest.dependencies, ...bootManifest.peerDependencies})) {
    const target = path.join(f.modules, name);
    if (await lstat(target).then(() => true, () => false)) continue;
    let entry = path.dirname(bootRequire.resolve(name));
    while (JSON.parse(await readFile(path.join(entry, "package.json"), "utf8").catch(() => "{}")).name !== name) entry = path.dirname(entry);
    await mkdir(path.dirname(target), {recursive: true});
    await symlink(entry, target, "junction");
  }
  const boot = path.join(f.modules, "@deepseek-ai/dsh-app-boot");
  await cp(new URL("./fixtures/dsh-app-boot-0.2.1-rc.2", import.meta.url), boot, {recursive: true});
  await pkg(boot, "@deepseek-ai/dsh-app-boot", "0.2.1-rc.2", {type: "module"});
  await patchDshProfileBundleResolution(boot);
  const original = await readFile(path.join(boot, "lib/index.js"), "utf8");
  const patched = enforceHarnessCoreDependencies(original, readHarnessCorePackages(f.dshBinPath));
  expect(enforceHarnessCoreDependencies(patched, readHarnessCorePackages(f.dshBinPath))).toBe(patched);
  expect(() => enforceHarnessCoreDependencies("unsupported", {})).toThrow("supported runtime resolver");
  await pkg(path.dirname(f.modules), "harness", "1.0.0", {type: "module", dependencies: {"@deepseek-ai/dsh-llm": "0.2.1-rc.2"}});
  // Both a top-level declaration and a private nested core copy must lose.
  await cp(f.old, path.join(f.profile, "node_modules/good-extension/node_modules/@deepseek-ai/dsh-llm"), {recursive: true});
  await pkg(path.join(f.profile, "node_modules/good-extension/node_modules/ordinary-lib"), "ordinary-lib", "1.0.0", {type: "module", exports: "./index.js"});
  await writeFile(path.join(f.profile, "node_modules/good-extension/node_modules/ordinary-lib/index.js"), 'export default "private-library";');
  await pkg(path.join(f.profile, "node_modules/good-extension/node_modules/constructor"), "constructor", "1.0.0", {type: "module", exports: "./index.js"});
  await writeFile(path.join(f.profile, "node_modules/good-extension/node_modules/constructor/index.js"), 'export default "ordinary-constructor";');
  await writeFile(path.join(f.profile, "node_modules/good-extension/probe.mjs"), `
    import {version} from '@deepseek-ai/dsh-llm';
    import {createRequire} from 'node:module';
    import library from 'ordinary-lib';
    import ordinaryConstructor from 'constructor';
    import {fileURLToPath} from 'node:url';
    const require = createRequire(import.meta.url);
    let esmMissing = false, cjsMissing = false;
    try { await import('@deepseek-ai/dsh-llm/legacy'); } catch (error) { esmMissing = error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }
    try { require('@deepseek-ai/dsh-llm/legacy'); } catch (error) { cjsMissing = error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }
    const explicitCore = require(require.resolve('@deepseek-ai/dsh-llm', {paths:[fileURLToPath(new URL('.',import.meta.url))]})).version;
    const ordinaryByPaths = require(require.resolve('ordinary-lib', {paths:[fileURLToPath(new URL('.',import.meta.url))]})).default;
    export default [version, require('@deepseek-ai/dsh-llm').version, library, esmMissing, cjsMissing, ordinaryConstructor, explicitCore, ordinaryByPaths];
  `);
  const preload = path.join(f.root, "core-policy.mjs");
  await writeFile(preload, ts.transpileModule(await readFile(new URL("../src/harness-core-dependencies.ts", import.meta.url), "utf8"), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText);
  const script = path.join(path.dirname(f.modules), "probe.mjs");
  await writeFile(script, `
    import {Context} from '@deepseek-ai/cordis';
    import {pathToFileURL} from 'node:url';
    import {PluginPackages, createRuntimeResolution, loadProfileDirectory, evaluatePluginCompatibility} from ${JSON.stringify(pathToFileURL(path.join(boot, "lib/index.js")).href)};
    const profile = loadProfileDirectory('dsh', ${JSON.stringify(f.profile)}, ${JSON.stringify(path.join(path.dirname(f.modules), "package.json"))});
    if (!profile.skippedBundles.some(x => x.packageName === 'dsh-llm-codex')) throw new Error('old extension not denied');
    if (profile.skippedBundles.some(x => x.packageName === 'good-extension')) throw new Error('compatible extension denied');
    const resolution = await createRuntimeResolution({installAnchor:${JSON.stringify(path.join(path.dirname(f.modules), "package.json"))}, profile, home:${JSON.stringify(f.home)}});
    const ctx = new Context();
    const packages = new PluginPackages(ctx, {resolution});
    const base = pathToFileURL(${JSON.stringify(path.join(f.profile, "cordis.yml"))}).href;
    const metadata = packages.packageOf('@deepseek-ai/dsh-llm', base);
    const values = (await import(pathToFileURL(${JSON.stringify(path.join(f.profile, "node_modules/good-extension/probe.mjs"))}).href)).default;
    const bad = evaluatePluginCompatibility({name:'dsh-llm-codex',version:'0.1.2',dependencies:{'@deepseek-ai/dsh-llm':'0.1.0-rc.6'}});
    console.log(JSON.stringify({values, version: metadata.version, bad: bad.requirements}));
  `);
  const electron = createRequire(import.meta.url)("electron") as string;
  const result = await execute(electron, ["--expose-internals", "--import", pathToFileURL(preload).href, script], {
    env: {...process.env, ELECTRON_RUN_AS_NODE: "1", ARKME_CORE_POLICY_BIN: f.dshBinPath}, timeout: 25_000
  });
  const resultData = JSON.parse(result.stdout.trim());
  expect(resultData.values).toEqual(["new-core", "new-core", "private-library", true, true, "ordinary-constructor", "new-core", "private-library"]);
  expect(resultData.version).toBe("0.2.1-rc.2");
  expect(resultData.bad).toEqual({"dependencies.@deepseek-ai/dsh-llm": "0.1.0-rc.6"});
  expect(await readFile(path.join(boot, "lib/index.js"), "utf8")).toBe(original);
}, 30_000);
