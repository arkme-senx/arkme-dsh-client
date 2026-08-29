# Harness Plugin Source Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm dev` build and use a local Arkme plugin directly while production packaging installs a commit-pinned remote Git plugin and embeds verifiable source provenance.

**Architecture:** Development source selection is an Electron launch concern: a small launcher resolves, validates, builds, and passes an absolute `ARKME_PLUGIN_PATH`, which non-packaged runtime resolution honors. Production source selection is a pnpm concern: root and runtime packages share a named catalog pinned to one full Git SHA, `pnpm deploy` materializes it, and runtime preparation verifies and records the source. Plugin Profile provisioning reads the selected package manifest dynamically so development and production versions may differ safely.

**Tech Stack:** Node.js 24+, TypeScript 6, ESM JavaScript, pnpm 11.19, Vitest 4, Electron 43, YAML 2.9.

**Spec:** `docs/superpowers/specs/2026-08-20-plugin-source-environments-design.md`

## Global Constraints

- No UI files or behavior are changed.
- Development defaults to `../arkme-dsh-plugin` and accepts an absolute or relative `ARKME_PLUGIN_PATH` override.
- A user-supplied invalid `ARKME_PLUGIN_PATH` must fail; it must never fall back silently.
- Packaged runtime must ignore `ARKME_PLUGIN_PATH` and use only `app.asar.unpacked/node_modules/@senguoyun/dsh-arkme`.
- Production remains on plugin version `0.1.4`, pinned to commit `d29c844420016a22f40619c4bfe1f5719b0752ef`.
- Production pins must use a complete 40-character hexadecimal commit SHA, never a branch or tag.
- `pnpm install --frozen-lockfile` remains the production installation contract.
- Harness must not copy files into or modify the local plugin repository.
- Do not run `git add`, `git commit`, or `git push` without a separate explicit user confirmation and the repository commit confirmation gate.

---

## File Structure

### New files

- `scripts/development-plugin.mjs` — pure/testable local plugin source selection, manifest validation, command construction, and child-process execution helpers.
- `scripts/run-development.mjs` — thin executable entry point that invokes the development plugin workflow.
- `scripts/production-plugin-source.mjs` — parses and validates the production catalog and lockfile, verifies a materialized plugin, and writes provenance.
- `tests/development-plugin.test.ts` — local/default/fallback source resolution and command sequencing tests.
- `tests/production-plugin-source.test.ts` — catalog/lock consistency, full-SHA enforcement, runtime containment, and provenance tests.

### Modified files

- `src/runtime-path.ts` — honors the development path override only for non-packaged runs.
- `src/plugin-profile.ts` — derives plugin version and contract from the selected manifest.
- `scripts/prepare-runtime.mjs` — consumes the deployed remote plugin and emits provenance instead of copying vendor content.
- `scripts/packaged-smoke.mjs` — validates provenance and the actual packaged plugin version dynamically.
- `package.json` — switches plugin dependency to `catalog:production`, adds YAML, and routes `pnpm dev` through the launcher.
- `runtime/package.json` — switches the packaged plugin dependency to `catalog:production`.
- `pnpm-workspace.yaml` — removes vendor workspace and defines the production Git source.
- `pnpm-lock.yaml` — records the named catalog and resolved Git commit.
- `tests/runtime-path.test.ts` — covers override, fallback, path normalization, and packaged isolation.
- `tests/plugin-profile.test.ts` — covers dynamic versions and the full package contract.
- `tests/app-manifest.test.ts` — covers the new development launcher and production dependency declaration.
- `tests/runtime-manifest.test.ts` — expects `catalog:production`.
- `tests/real-dsh.smoke.test.ts` — passes the development override through the shared resolver.
- `README.md` — documents one-command development, optional path override, and production pinning.

### Removed files

- `scripts/sync-arkme-plugin.mjs` — manual vendor synchronization is obsolete.
- `scripts/materialize-workspace-package.mjs` and `scripts/materialize-workspace-package.d.mts` — runtime no longer replaces a workspace link with vendor files.
- `tests/vendor-plugin.test.ts` — replaced by production source and packaged provenance tests.
- `tests/materialize-workspace-package.test.ts` — tests an obsolete vendor-only helper.

---

### Task 1: Runtime Override and Dynamic Plugin Contract

**Files:**
- Modify: `src/runtime-path.ts:32-56`
- Modify: `src/plugin-profile.ts:16-98`
- Modify: `tests/runtime-path.test.ts`
- Modify: `tests/plugin-profile.test.ts`

**Interfaces:**
- Produces: `developmentArkmePluginPath(fromModuleUrl: string, environment?: NodeJS.ProcessEnv): string`
- Produces: `resolveArkmePluginPath(isPackaged: boolean, resourcesPath: string, fromModuleUrl: string, environment?: NodeJS.ProcessEnv): string`
- Produces internally: `validatePlugin(pluginDir: string): Promise<{ version: string }>`
- Consumes: plugin `package.json` containing `name`, non-empty `version`, and `dsh.bundle.patch`.

- [ ] **Step 1: Write failing runtime path tests**

Add tests that pass explicit environment objects so the test process environment is never mutated:

```ts
test("uses and normalizes an explicit local plugin path in development", () => {
  expect(developmentArkmePluginPath(import.meta.url, {
    ARKME_PLUGIN_PATH: "../arkme-dsh-plugin"
  })).toBe(path.resolve("../arkme-dsh-plugin"));
});

test("ignores a local plugin override in a packaged application", () => {
  expect(resolveArkmePluginPath(
    true,
    "/Applications/arkme.app/Contents/Resources",
    import.meta.url,
    { ARKME_PLUGIN_PATH: "/tmp/untrusted-plugin" }
  )).toBe(path.join(
    "/Applications/arkme.app/Contents/Resources",
    "app.asar.unpacked/node_modules/@senguoyun/dsh-arkme"
  ));
});
```

Retain a fallback test with `{}` that verifies Node resolves the installed production dependency.

- [ ] **Step 2: Run runtime path tests and verify RED**

Run: `pnpm test tests/runtime-path.test.ts`

Expected: FAIL because both functions currently lack an environment parameter and the development resolver ignores `ARKME_PLUGIN_PATH`.

- [ ] **Step 3: Implement the minimal runtime override**

Implement the non-packaged-only precedence:

```ts
export function developmentArkmePluginPath(
  fromModuleUrl: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const configuredPath = environment.ARKME_PLUGIN_PATH?.trim();
  if (configuredPath !== undefined && configuredPath !== "") {
    return path.resolve(configuredPath);
  }
  const require = createRequire(fromModuleUrl);
  return path.dirname(require.resolve("@senguoyun/dsh-arkme/package.json"));
}
```

Add the same optional environment argument to `resolveArkmePluginPath`, passing it only to the non-packaged branch.

- [ ] **Step 4: Run runtime path tests and verify GREEN**

Run: `pnpm test tests/runtime-path.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing Profile tests for dynamic versions and complete artifacts**

Update `createFixture` to accept a version argument and create both entries:

```ts
await mkdir(path.join(pluginDir, "lib"));
await writeFile(path.join(pluginDir, "lib", "index.js"), "export {};\n");
await writeFile(path.join(pluginDir, "lib", "client.js"), "module.exports = {};\n");
```

Add assertions that a fixture version `9.8.7-local` is written into Profile dependencies. Add table-driven rejection cases for an empty version, the wrong package name, the wrong patch path, and each missing required file.

- [ ] **Step 6: Run Profile tests and verify RED**

Run: `pnpm test tests/plugin-profile.test.ts`

Expected: FAIL because the implementation requires `0.1.4` and only checks `cordis.patch.yml`.

- [ ] **Step 7: Implement dynamic manifest validation**

Replace `PLUGIN_VERSION` use with one parsed manifest result:

```ts
interface ValidatedPlugin {
  version: string;
}

async function validatePlugin(pluginDir: string): Promise<ValidatedPlugin> {
  const manifest = JSON.parse(await readFile(path.join(pluginDir, "package.json"), "utf8")) as JsonObject;
  const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  const patch = asObject(asObject(manifest.dsh).bundle).patch;
  if (manifest.name !== PLUGIN_NAME || version === "" || patch !== "./cordis.patch.yml") {
    throw new Error(`Invalid embedded Arkme plugin at ${pluginDir}`);
  }
  await Promise.all([
    access(path.join(pluginDir, "cordis.patch.yml")),
    access(path.join(pluginDir, "lib", "index.js")),
    access(path.join(pluginDir, "lib", "client.js"))
  ]);
  return { version };
}
```

Use the returned version when writing Profile dependencies.

- [ ] **Step 8: Run focused and regression tests**

Run: `pnpm test tests/plugin-profile.test.ts tests/runtime-path.test.ts tests/real-dsh.smoke.test.ts`

Expected: PASS; the real DSH test remains skipped unless `RUN_REAL_DSH_SMOKE=1`.

- [ ] **Step 9: Commit checkpoint**

Do not execute without separate approval. Suggested commit: `feat(harness): resolve development plugin dynamically`.

---

### Task 2: One-Command Development Launcher

**Files:**
- Create: `scripts/development-plugin.mjs`
- Create: `scripts/run-development.mjs`
- Create: `tests/development-plugin.test.ts`
- Modify: `package.json:13-26`
- Modify: `tests/app-manifest.test.ts`

**Interfaces:**
- Produces: `resolveDevelopmentPlugin({ projectRoot, workingDirectory, environment, resolveInstalledPlugin }): Promise<{ path: string; source: "local" | "production"; version: string }>`
- Produces: `buildDevelopmentCommands(options): readonly { command: string; args: readonly string[]; cwd: string; environment?: Record<string, string> }[]`
- Produces: `runDevelopment(options): Promise<void>` with injected `runCommand` for tests.
- Consumes: Task 1's runtime interpretation of `ARKME_PLUGIN_PATH`.

- [ ] **Step 1: Write failing source-resolution tests**

Use temporary plugin directories and dependency injection for the installed fallback:

```ts
const selected = await resolveDevelopmentPlugin({
  projectRoot,
  workingDirectory: process.cwd(),
  environment: { ARKME_PLUGIN_PATH: localPlugin },
  resolveInstalledPlugin: () => installedPlugin
});
expect(selected).toEqual({ path: path.resolve(localPlugin), source: "local", version: "0.1.8" });
```

Cover these cases:

- Explicit valid path selects local.
- Relative explicit path resolves against the caller working directory.
- Explicit missing path rejects and never calls `resolveInstalledPlugin`.
- No explicit path plus existing sibling selects local.
- No explicit path plus missing sibling selects installed production.
- Wrong package name, empty version, wrong patch path, or missing build inputs rejects.

- [ ] **Step 2: Run launcher tests and verify RED**

Run: `pnpm test tests/development-plugin.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement source selection and validation**

Use `access`, `readFile`, and `path.resolve`; distinguish explicit override from default selection before checking existence. Return an actionable error containing the resolved path and `ARKME_PLUGIN_PATH` when explicit selection fails.

- [ ] **Step 4: Add failing command-order tests**

Inject a recording runner and assert local mode executes exactly:

```ts
expect(calls.map(({ command, args }) => [command, args])).toEqual([
  [pnpmExecutable, ["run", "build"]],
  [pnpmExecutable, ["exec", "tsc", "-p", "tsconfig.build.json"]],
  [process.execPath, ["scripts/copy-static.mjs"]],
  [electronExecutable, ["."]]
]);
expect(calls.at(-1)?.environment?.ARKME_PLUGIN_PATH).toBe(localPlugin);
```

Production fallback mode must omit the plugin build but retain Harness compile, static copy, and Electron launch.

- [ ] **Step 5: Implement command construction and execution**

Use `pnpm.cmd` on Windows and `pnpm` elsewhere. Reuse the existing Windows shell rule used by runtime rebuilds. Each command inherits stdio; any nonzero exit rejects with command, code, and signal. Set `ARKME_PLUGIN_PATH` only for local mode, and log source, path, and version before running commands.

- [ ] **Step 6: Add the thin executable and switch the manifest**

`scripts/run-development.mjs` calls `runDevelopment` with `projectRoot`, `process.cwd()`, `process.env`, and platform executables. Update scripts:

```json
"dev": "node scripts/run-development.mjs",
"build": "tsc -p tsconfig.build.json && node scripts/copy-static.mjs"
```

Keep production plugin verification out of generic TypeScript build; it belongs to runtime preparation. Add an app-manifest assertion that `dev` points to the launcher and no script invokes `sync:plugin`.

- [ ] **Step 7: Run launcher and manifest tests**

Run: `pnpm test tests/development-plugin.test.ts tests/app-manifest.test.ts`

Expected: PASS.

- [ ] **Step 8: Run the launcher up to the Electron boundary with a test runner**

Run: `pnpm test tests/development-plugin.test.ts --reporter=verbose`

Expected: PASS with the test proving plugin build precedes Harness compile and Electron startup.

- [ ] **Step 9: Commit checkpoint**

Do not execute without separate approval. Suggested commit: `feat(harness): add local plugin development launcher`.

---

### Task 3: Commit-Pinned Production Dependency

**Files:**
- Create: `scripts/production-plugin-source.mjs`
- Create: `tests/production-plugin-source.test.ts`
- Modify: `package.json`
- Modify: `runtime/package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `tests/runtime-manifest.test.ts`
- Modify: `tests/app-manifest.test.ts`

**Interfaces:**
- Produces: `readProductionPluginSource({ workspaceManifestPath, lockfilePath }): Promise<{ packageName: string; repository: string; commit: string; dependencySpec: string }>`
- Produces: `assertProductionManifestReferencesCatalog(manifest, manifestName): void`
- Uses direct dependency: `yaml@2.9.0` and `parse` from `yaml`.
- Consumes: pnpm named catalog `production` and the generated lockfile importer/resolution data.

- [ ] **Step 1: Write failing production manifest tests**

Update `tests/app-manifest.test.ts` and `tests/runtime-manifest.test.ts` to assert root and runtime declare `catalog:production`, workspace packages exclude vendor, and the production catalog contains the exact Git commit.

- [ ] **Step 2: Run manifest tests and verify RED**

Run: `pnpm test tests/runtime-manifest.test.ts tests/app-manifest.test.ts`

Expected: FAIL because both manifests still use `workspace:*` and workspace still includes vendor.

- [ ] **Step 3: Add catalog and direct YAML dependency**

Set both plugin dependency declarations to `catalog:production`, add `yaml: 2.9.0` to root dev dependencies, remove vendor from workspace packages, and define:

```yaml
catalogs:
  production:
    '@senguoyun/dsh-arkme': git+ssh://git@github.com/arkme-senx/arkme-dsh-plugin.git#d29c844420016a22f40619c4bfe1f5719b0752ef
```

- [ ] **Step 4: Generate the lockfile and inspect the real Git resolution shape**

Run: `pnpm install --lockfile-only`

Expected: PASS and `pnpm-lock.yaml` records the catalog spec plus resolved commit. This step may require approved network access to the Git remote. Inspect only the Arkme importer, package, and snapshot entries; record their exact pnpm 11 structure in the following test fixture.

- [ ] **Step 5: Write failing production source parser tests**

Create YAML fixture strings using the exact workspace and lock structure observed in Step 4. Assert the parser returns:

```ts
{
  packageName: "@senguoyun/dsh-arkme",
  repository: "git@github.com:arkme-senx/arkme-dsh-plugin.git",
  commit: "d29c844420016a22f40619c4bfe1f5719b0752ef",
  dependencySpec: "git+ssh://git@github.com/arkme-senx/arkme-dsh-plugin.git#d29c844420016a22f40619c4bfe1f5719b0752ef"
}
```

Add rejection tests for a branch/tag, short SHA, missing catalog, root/runtime manifest not using `catalog:production`, missing lock resolution, and a different resolved commit.

- [ ] **Step 6: Run parser tests and verify RED**

Run: `pnpm test tests/production-plugin-source.test.ts`

Expected: FAIL because the parser does not exist.

- [ ] **Step 7: Implement YAML-based source and lock validation**

Parse both YAML documents as objects. Extract the catalog dependency, enforce `/#[0-9a-f]{40}$/i`, normalize the repository by removing the `git+ssh://` transport prefix for provenance, and follow the runtime importer resolution to its package resolution commit. Reject inconsistencies with an error containing both expected and resolved commits.

- [ ] **Step 8: Run focused production configuration tests**

Run: `pnpm test tests/production-plugin-source.test.ts tests/runtime-manifest.test.ts tests/app-manifest.test.ts`

Expected: PASS.

- [ ] **Step 9: Verify frozen installation**

Run: `pnpm install --frozen-lockfile --offline`

Expected: PASS if the Git package is cached by Step 4. If pnpm cannot use the cached Git package offline, rerun `pnpm install --frozen-lockfile` with approved network access and require PASS.

- [ ] **Step 10: Commit checkpoint**

Do not execute without separate approval. Suggested commit: `build(harness): pin production plugin source`.

---

### Task 4: Self-Contained Runtime Provenance

**Files:**
- Modify: `scripts/production-plugin-source.mjs`
- Modify: `tests/production-plugin-source.test.ts`
- Modify: `scripts/prepare-runtime.mjs:1-145`
- Modify: `scripts/packaged-smoke.mjs:1-42`
- Delete: `scripts/materialize-workspace-package.mjs`
- Delete: `scripts/materialize-workspace-package.d.mts`
- Delete: `tests/materialize-workspace-package.test.ts`
- Delete: `tests/vendor-plugin.test.ts`

**Interfaces:**
- Produces: `verifyRuntimePlugin({ pluginDir, runtimeRoot, source }): Promise<{ packageName: string; packageVersion: string }>`
- Produces: `writePluginProvenance({ pluginDir, source, packageVersion }): Promise<string>` returning the written path.
- Produces file: `PLUGIN_PROVENANCE.json` with `schemaVersion`, `source`, `repository`, `commit`, `packageName`, and `packageVersion`.
- Consumes: Task 3's `readProductionPluginSource` result.

- [ ] **Step 1: Write failing runtime verification tests**

Create a temporary runtime plugin with package manifest, patch, and both entries. Verify the success result and add failures for missing files, wrong package name, empty version, a plugin path outside runtime, and a plugin path that remains a symbolic link to outside runtime.

- [ ] **Step 2: Write failing provenance tests**

Call `writePluginProvenance` and assert exact JSON:

```ts
expect(JSON.parse(await readFile(provenancePath, "utf8"))).toEqual({
  schemaVersion: 1,
  source: "git",
  repository: "git@github.com:arkme-senx/arkme-dsh-plugin.git",
  commit: "d29c844420016a22f40619c4bfe1f5719b0752ef",
  packageName: "@senguoyun/dsh-arkme",
  packageVersion: "0.1.4"
});
```

- [ ] **Step 3: Run provenance tests and verify RED**

Run: `pnpm test tests/production-plugin-source.test.ts`

Expected: FAIL because runtime verification/provenance functions do not exist.

- [ ] **Step 4: Implement containment, contract, and provenance**

Resolve `realpath(runtimeRoot)` and `realpath(pluginDir)` and require the plugin path to equal or descend from `${runtimeRealPath}${path.sep}`. Require `lstat(pluginDir).isDirectory()` after node_modules materialization, validate the manifest and required files, then write newline-terminated formatted JSON.

- [ ] **Step 5: Replace vendor materialization in runtime preparation**

Remove the import and call to `materializeWorkspacePackage`. After `materializeRuntimeNodeModules(runtimeRoot)`, assert the deployed plugin exists, read production source configuration, verify it is self-contained, write provenance, and retain the existing import smoke for `lib/index.js`.

- [ ] **Step 6: Update packaged smoke**

Replace hardcoded `0.1.4` and `UPSTREAM_COMMIT` checks with:

```js
const pluginManifest = JSON.parse(await readFile(path.join(plugin, "package.json"), "utf8"));
const provenance = JSON.parse(await readFile(path.join(plugin, "PLUGIN_PROVENANCE.json"), "utf8"));
if (
  provenance.packageName !== pluginManifest.name ||
  provenance.packageVersion !== pluginManifest.version ||
  provenance.commit !== expectedSource.commit
) {
  throw new Error("Packaged Arkme plugin source metadata is inconsistent");
}
```

Use `readProductionPluginSource` to obtain `expectedSource`; keep the existing real packaged route smoke.

- [ ] **Step 7: Remove obsolete vendor helpers and tests**

Delete only the four files listed in this task after `rg` confirms they have no remaining imports. Do not remove the ignored `vendor/arkme-dsh-plugin/` rule in this change.

- [ ] **Step 8: Run focused runtime tests**

Run: `pnpm test tests/production-plugin-source.test.ts tests/runtime-rebuild.test.ts tests/app-manifest.test.ts`

Expected: PASS.

- [ ] **Step 9: Prepare a production runtime**

Run: `pnpm run build && pnpm run prepare:runtime`

Expected: PASS; `.runtime/dsh/node_modules/@senguoyun/dsh-arkme` is a real directory containing `PLUGIN_PROVENANCE.json` with the exact pinned commit and actual manifest version.

- [ ] **Step 10: Commit checkpoint**

Do not execute without separate approval. Suggested commit: `build(harness): embed plugin source provenance`.

---

### Task 5: Cleanup, Documentation, and Full Verification

**Files:**
- Delete: `scripts/sync-arkme-plugin.mjs`
- Modify: `README.md`
- Modify: `tests/real-dsh.smoke.test.ts`
- Modify: `tests/runtime-path.test.ts`
- Modify: `tests/plugin-profile.test.ts`
- Modify: `scripts/packaged-smoke.mjs`

**Interfaces:**
- Consumes: `pnpm dev`, `ARKME_PLUGIN_PATH`, production catalog pin, and `PLUGIN_PROVENANCE.json` from Tasks 1-4.
- Produces: documented developer and production workflows with no vendor synchronization step.

- [ ] **Step 1: Add failing documentation/configuration assertions**

Extend manifest/config tests to assert no script contains `sync:plugin` or `vendor/arkme-dsh-plugin`, and assert README contains `ARKME_PLUGIN_PATH`, `pnpm dev`, `catalog:production`, and the pinned production commit.

- [ ] **Step 2: Run the assertions and verify RED**

Run: `pnpm test tests/app-manifest.test.ts tests/runtime-manifest.test.ts`

Expected: FAIL while the obsolete script and documentation remain.

- [ ] **Step 3: Remove the sync script and update README**

Document exactly:

```bash
# Default sibling plugin repository
pnpm dev

# Explicit local plugin repository
ARKME_PLUGIN_PATH=/absolute/path/to/arkme-dsh-plugin pnpm dev

# Production install and build
pnpm install --frozen-lockfile
pnpm run dist
```

Explain that development builds the local plugin once before startup, plugin changes require restarting Harness, production ignores the environment override, and production upgrades require changing the full Git SHA plus lockfile in one reviewed change. Correct the obsolete README commit/version statement.

- [ ] **Step 4: Update real DSH smoke source resolution**

Pass `process.env` through `developmentArkmePluginPath(import.meta.url, process.env)` while retaining `PACKAGED_ARKME_PLUGIN` as the explicit test-only packaged override. Do not weaken the production app resolver.

- [ ] **Step 5: Remove stale literal-version assumptions**

Run: `rg -n '0\.1\.4|85409e035852e143a6dc56912fecf145f5c40314|vendor/arkme-dsh-plugin|sync:plugin|UPSTREAM_COMMIT' src scripts tests package.json runtime pnpm-workspace.yaml README.md`

Expected remaining `0.1.4` occurrences are limited to production pin/provenance fixtures and documentation describing the preserved production version; the old `85409e...`, executable vendor references, sync command, and `UPSTREAM_COMMIT` checks have zero matches.

- [ ] **Step 6: Run full automated verification**

Run: `pnpm test`

Expected: PASS.

Run: `pnpm run typecheck`

Expected: PASS with no TypeScript diagnostics.

Run: `pnpm run build`

Expected: PASS and `dist/main.js`, `dist/preload.cjs`, UI files, and runtime path code are generated.

- [ ] **Step 7: Run production runtime verification**

Run: `pnpm run prepare:runtime`

Expected: PASS and the runtime plugin provenance matches `d29c844420016a22f40619c4bfe1f5719b0752ef`.

- [ ] **Step 8: Run packaging verification when the host supports it**

Run: `pnpm run pack`

Expected: PASS and `release/mac-arm64/arkme.app` contains a self-contained plugin. If signing, native rebuild, or platform tooling prevents packaging, record the exact external blocker; do not claim packaged verification passed.

- [ ] **Step 9: Inspect the final diff**

Run: `git status --short && git diff --check && git diff --stat`

Expected: only the approved Harness source/config/test/docs changes plus the already approved design and plan documents; no plugin repository changes and no whitespace errors.

- [ ] **Step 10: Commit checkpoint**

Do not execute without separate approval. Suggested commit: `docs(harness): document plugin source environments`.
