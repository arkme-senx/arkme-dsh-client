# Windows Core Plugin Install Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Windows installer run reset Arkme's core plugin to a verified bundled artifact while preventing Profile package operations from modifying the application installation directory.

**Architecture:** The harness build produces a verified `dsh-arkme.tgz` seed outside the mutable runtime plugin path. NSIS invalidates a bootstrap receipt on every install; the next desktop startup safely detaches legacy junctions, clears only core-plugin update state, installs the seed as a physical Profile directory, validates it, and writes the receipt. Both updater paths independently detach any remaining legacy junction before invoking pnpm.

**Tech Stack:** TypeScript 6, Node.js 24 filesystem/crypto APIs, Electron 43, electron-builder 26 NSIS, pnpm 11.19.0, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-26-windows-plugin-install-repair-design.md`

## Global Constraints

- DSH Profile must never link `@senguoyun/dsh-arkme` to the application installation directory in packaged production.
- Every Windows installer run, including same-version reinstall, resets the core plugin to the installer-bundled version.
- Bootstrap and repair are offline and use only the bundled seed artifact.
- Preserve settings, workspace, login state, business databases, uploads, OpenClaw state, other dependencies, other bundles, and other extensions.
- Clear only the core-plugin directory, its dependency/lock state, `plugin-cache`, update state, install state, install receipts, and stale update plans.
- Never recursively remove a symlink or NTFS junction; use `lstat` followed by `unlink`.
- Keep pnpm pinned to `11.19.0` and DSH pinned to `0.1.0-rc.8`.
- Do not overwrite the existing uncommitted lifecycle logging changes in `arkme-dsh-plugin/src/plugin-update.ts`, `src/plugin-updater-helper.ts`, or their tests.
- Do not include the existing uncommitted `jotmo-harness/src/harness-supervisor.ts` changes in task commits.

## File Structure

### `jotmo-harness`

- Create `scripts/runtime-plugin-seed.mjs`: build and validate the packaged `.tgz` seed and its SHA-512 manifest.
- Create `scripts/runtime-plugin-seed.d.mts`: typed seed manifest and build API for TypeScript tests.
- Create `tests/runtime-plugin-seed.test.ts`: seed build and validation tests.
- Create `src/plugin-install-bootstrap.ts`: validate/copy the seed, decide whether reset is required, safely clear core-plugin state, and write the bootstrap receipt.
- Create `tests/plugin-install-bootstrap.test.ts`: reset, preservation, retry, and link-safety tests.
- Modify `src/plugin-profile.ts`: support an embedded `file:` artifact and return the physical Profile plugin path.
- Modify `tests/plugin-profile.test.ts`: prove artifact installs are physical and installer-forced reset overrides a newer plugin.
- Create `src/plugin-startup.ts` and `tests/plugin-startup.test.ts`: testable packaged bootstrap/provision/receipt orchestration.
- Modify `src/main.ts`: run bootstrap before normal startup and use the Profile plugin helper path.
- Create `build/installer.nsh`: verify installed files and invalidate the bootstrap receipt on every NSIS run.
- Modify `package.json` and `tests/app-manifest.test.ts`: package the seed and register the NSIS include.
- Modify `scripts/prepare-runtime.mjs`: create the seed after production plugin validation.
- Modify `scripts/packaged-smoke.mjs`: use the existing platform layout resolver and verify the seed.
- Create `tests/windows-plugin-install-repair.integration.test.ts`: real Windows junction regression test, skipped on non-Windows hosts.

### `arkme-dsh-plugin`

- Create `src/profile-plugin-entry.ts`: derive the exact managed path and detach only a symlink/junction.
- Create `tests/profile-plugin-entry.test.ts`: path containment and target-preservation tests.
- Modify `src/plugin-updater-helper.ts` and `src/plugin-update.ts`: call the guard before every remove operation, including rollback cleanup.
- Modify `tests/plugin-updater-helper.test.ts` and `tests/plugin-update.test.ts`: integration coverage for helper and supervised updater paths.

---

### Task 1: Build a verified runtime plugin seed

**Files:**
- Create: `jotmo-harness/scripts/runtime-plugin-seed.mjs`
- Create: `jotmo-harness/scripts/runtime-plugin-seed.d.mts`
- Create: `jotmo-harness/tests/runtime-plugin-seed.test.ts`
- Modify: `jotmo-harness/scripts/prepare-runtime.mjs:79`

**Interfaces:**
- Consumes: a validated staged plugin directory and an injected `pack(destinationDirectory)` callback.
- Produces: `createRuntimePluginSeed(options): Promise<RuntimePluginSeedManifest>` and fixed files `arkme-plugin-seed/manifest.json` plus `arkme-plugin-seed/dsh-arkme.tgz`.

- [ ] **Step 1: Write the failing seed test**

```ts
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createRuntimePluginSeed } from "../scripts/runtime-plugin-seed.mjs";

test("creates a fixed-name plugin seed and SHA-512 manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arkme-seed-"));
  const pluginDir = path.join(root, "plugin");
  const seedDir = path.join(root, "seed");
  await mkdir(pluginDir);
  await writeFile(path.join(pluginDir, "package.json"), JSON.stringify({
    name: "@senguoyun/dsh-arkme",
    version: "0.1.17"
  }));
  const bytes = Buffer.from("valid packed plugin bytes");
  const manifest = await createRuntimePluginSeed({
    pluginDir,
    seedDir,
    pack: async directory => {
      const artifact = path.join(directory, "senguoyun-dsh-arkme-0.1.17.tgz");
      await writeFile(artifact, bytes);
      return artifact;
    }
  });
  expect(manifest).toEqual({
    schemaVersion: 1,
    packageName: "@senguoyun/dsh-arkme",
    version: "0.1.17",
    artifactFileName: "dsh-arkme.tgz",
    artifactSha512: createHash("sha512").update(bytes).digest("hex")
  });
  expect(await readFile(path.join(seedDir, "dsh-arkme.tgz"))).toEqual(bytes);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd jotmo-harness && pnpm exec vitest run tests/runtime-plugin-seed.test.ts`

Expected: FAIL because `scripts/runtime-plugin-seed.mjs` does not exist.

- [ ] **Step 3: Implement seed creation and wire runtime preparation**

Implement the module with atomic temporary directories, exact package-name validation, semver-shaped version validation, fixed artifact naming, SHA-512 calculation, and atomic manifest rename:

```js
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const RUNTIME_PLUGIN_SEED_DIRECTORY = "arkme-plugin-seed";
export const RUNTIME_PLUGIN_SEED_MANIFEST = "manifest.json";
export const RUNTIME_PLUGIN_SEED_ARTIFACT = "dsh-arkme.tgz";

export async function createRuntimePluginSeed({ pluginDir, seedDir, pack }) {
  const pluginManifest = JSON.parse(await readFile(path.join(pluginDir, "package.json"), "utf8"));
  if (pluginManifest.name !== "@senguoyun/dsh-arkme"
      || typeof pluginManifest.version !== "string"
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pluginManifest.version)) {
    throw new Error("runtime plugin seed package metadata is invalid");
  }
  const temporaryDirectory = await mkdtemp(path.join(path.dirname(seedDir), ".arkme-plugin-seed-"));
  const nextDirectory = `${seedDir}.next-${process.pid}-${randomUUID()}`;
  try {
    const producedArtifact = path.resolve(await pack(temporaryDirectory));
    const relativeArtifact = path.relative(temporaryDirectory, producedArtifact);
    if (relativeArtifact.startsWith("..") || path.isAbsolute(relativeArtifact)) {
      throw new Error("runtime plugin seed pack output escaped its temporary directory");
    }
    const bytes = await readFile(producedArtifact);
    const manifest = {
      schemaVersion: 1,
      packageName: "@senguoyun/dsh-arkme",
      version: pluginManifest.version,
      artifactFileName: RUNTIME_PLUGIN_SEED_ARTIFACT,
      artifactSha512: createHash("sha512").update(bytes).digest("hex")
    };
    await mkdir(nextDirectory, { recursive: false });
    await copyFile(producedArtifact, path.join(nextDirectory, RUNTIME_PLUGIN_SEED_ARTIFACT));
    await writeFile(
      path.join(nextDirectory, RUNTIME_PLUGIN_SEED_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" }
    );
    await rm(seedDir, { recursive: true, force: true });
    await rename(nextDirectory, seedDir);
    return manifest;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
    await rm(nextDirectory, { recursive: true, force: true });
  }
}
```

Declare the corresponding `.d.mts` API exactly as:

```ts
export interface RuntimePluginSeedManifest {
  schemaVersion: 1;
  packageName: "@senguoyun/dsh-arkme";
  version: string;
  artifactFileName: "dsh-arkme.tgz";
  artifactSha512: string;
}

export function createRuntimePluginSeed(options: {
  pluginDir: string;
  seedDir: string;
  pack: (destinationDirectory: string) => Promise<string>;
}): Promise<RuntimePluginSeedManifest>;
```

In `prepare-runtime.mjs`, after `prepareRuntimePluginTransaction` has validated and finalized `stagedPlugin`, call `createRuntimePluginSeed`. The injected `pack` callback must execute pinned pnpm as:

```js
await run(pnpmExecutable, ["pack", "--pack-destination", destination], stagedPlugin);
```

It must require exactly one generated `.tgz` and return its absolute path.

- [ ] **Step 4: Run seed and production-source tests**

Run: `cd jotmo-harness && pnpm exec vitest run tests/runtime-plugin-seed.test.ts tests/production-plugin-source.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit only Task 1 files**

```bash
cd jotmo-harness
git add scripts/runtime-plugin-seed.mjs scripts/runtime-plugin-seed.d.mts scripts/prepare-runtime.mjs tests/runtime-plugin-seed.test.ts
git commit -m "build: package verified Arkme plugin seed"
```

### Task 2: Add safe install-bootstrap state management

**Files:**
- Create: `jotmo-harness/src/plugin-install-bootstrap.ts`
- Create: `jotmo-harness/tests/plugin-install-bootstrap.test.ts`

**Interfaces:**
- Consumes: `{ resourcesPath, dshHome, appVersion, profileName }`.
- Produces: `preparePluginInstallBootstrap(options): Promise<PluginInstallBootstrapPreparation>`, `completePluginInstallBootstrap(options): Promise<void>`, and `profilePluginDirectory(dshHome, profileName): string`.

- [ ] **Step 1: Write failing tests for safe cleanup and data preservation**

Create fixtures containing a legacy junction, a target sentinel, `arkme-self/prod/plugin-cache`, update JSON files, a business database, uploads, another extension, and settings. Assert that preparation:

```ts
expect(result.resetRequired).toBe(true);
await expect(lstat(profilePluginPath)).rejects.toMatchObject({ code: "ENOENT" });
expect(await readFile(targetSentinel, "utf8")).toBe("keep installation target");
await expect(access(path.join(stateDirectory, "plugin-cache"))).rejects.toMatchObject({ code: "ENOENT" });
expect(await readFile(path.join(stateDirectory, "arkme.db"), "utf8")).toBe("keep database");
expect(await readFile(otherExtensionManifest, "utf8")).toContain("other-extension");
```

Add separate tests proving an invalid seed hash changes nothing, a matching receipt skips reset, and `completePluginInstallBootstrap` writes a receipt only after a healthy physical plugin is present.

- [ ] **Step 2: Run the tests and verify RED**

Run: `cd jotmo-harness && pnpm exec vitest run tests/plugin-install-bootstrap.test.ts`

Expected: FAIL because `src/plugin-install-bootstrap.ts` does not exist.

- [ ] **Step 3: Implement seed validation, atomic cache copy, cleanup, and receipt**

Use these exact public types:

```ts
export interface ManagedPluginArtifact {
  artifactPath: string;
  artifactSha512: string;
  packageName: "@senguoyun/dsh-arkme";
  version: string;
}

export interface PluginInstallBootstrapPreparation {
  artifact: ManagedPluginArtifact;
  profilePluginDir: string;
  resetRequired: boolean;
}

export async function preparePluginInstallBootstrap(options: {
  resourcesPath: string;
  dshHome: string;
  appVersion: string;
  profileName: string;
}): Promise<PluginInstallBootstrapPreparation>;

export async function completePluginInstallBootstrap(options: {
  dshHome: string;
  appVersion: string;
  profileName: string;
  artifact: ManagedPluginArtifact;
}): Promise<void>;

export function profilePluginDirectory(dshHome: string, profileName: string): string;
```

The receipt path is `dshHome/arkme-self/desktop-plugin-bootstrap.json`. The managed seed cache is `dshHome/arkme-self/plugin-seed/<version>/dsh-arkme.tgz`. Remove only `plugin-cache`, `plugin-update-state.json`, `plugin-update-install-state.json`, and names matching `plugin-update-plan-*.json` under `arkme-self/prod`. Link removal must branch on `lstat().isSymbolicLink()` before any recursive `rm`.

- [ ] **Step 4: Run bootstrap tests**

Run: `cd jotmo-harness && pnpm exec vitest run tests/plugin-install-bootstrap.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit only Task 2 files**

```bash
cd jotmo-harness
git add src/plugin-install-bootstrap.ts tests/plugin-install-bootstrap.test.ts
git commit -m "feat: reset managed plugin state after install"
```

### Task 3: Install the embedded artifact as a physical Profile package

**Files:**
- Modify: `jotmo-harness/src/plugin-profile.ts:44`
- Modify: `jotmo-harness/tests/plugin-profile.test.ts:21`

**Interfaces:**
- Consumes: Task 2 `ManagedPluginArtifact` shape through a structural `embeddedArtifact` option.
- Produces: `provisionArkmeWebProfile(options): Promise<ProvisionedArkmeProfile>` where `pluginDir` is always the actual loaded Profile path.

- [ ] **Step 1: Add failing physical-install and forced-reset tests**

Extend the options and expected return shape in tests:

```ts
const result = await provisionArkmeWebProfile({
  dshHome,
  embeddedArtifact: {
    artifactPath,
    artifactSha512,
    packageName: "@senguoyun/dsh-arkme",
    version: "0.1.17"
  },
  forceEmbedded: true,
  packageManager
});
expect(result.pluginDir).toBe(installedDir);
expect((await lstat(installedDir)).isSymbolicLink()).toBe(false);
expect(JSON.parse(await readFile(path.join(profileDir, "package.json"), "utf8"))
  .dependencies["@senguoyun/dsh-arkme"]).toBe(`file:${artifactPath}`);
```

Create the valid fixture `.tgz` by running the pinned local pnpm `pack` against `createPlugin(...)`. Seed the Profile with a healthy newer `file:` plugin first and assert `forceEmbedded: true` replaces it with `0.1.17`. Add a normal-start test with `forceEmbedded: false` proving the existing healthy receipt-based newer version remains selected.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd jotmo-harness && pnpm exec vitest run tests/plugin-profile.test.ts`

Expected: FAIL because `embeddedArtifact`, `forceEmbedded`, and the return value are unsupported.

- [ ] **Step 3: Implement artifact selection and physical validation**

Use these public additions:

```ts
export interface ProvisionedArkmeProfile {
  profileDir: string;
  pluginDir: string;
  source: "embedded" | "independent";
  version: string;
}
```

Keep `pluginDir` support for development callers. For `embeddedArtifact`, use `file:<absolute tgz path>`, require a package manager, never call `ensurePluginSymlink`, and after pnpm install require `lstat(pluginDir).isDirectory() === true`, `isSymbolicLink() === false`, matching package version, and healthy required files. `forceEmbedded` bypasses independent-plugin selection only for the current provisioning call. Write final managed-plugin health metadata after installation validation.

- [ ] **Step 4: Run Profile regression tests**

Run: `cd jotmo-harness && pnpm exec vitest run tests/plugin-profile.test.ts tests/real-dsh.smoke.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit only Task 3 files**

```bash
cd jotmo-harness
git add src/plugin-profile.ts tests/plugin-profile.test.ts
git commit -m "fix: materialize packaged plugin in Profile"
```

### Task 4: Wire bootstrap into desktop startup

**Files:**
- Create: `jotmo-harness/src/plugin-startup.ts`
- Create: `jotmo-harness/tests/plugin-startup.test.ts`
- Modify: `jotmo-harness/src/main.ts:1`

**Interfaces:**
- Consumes: Tasks 2 and 3 preparation/provisioning APIs.
- Produces: `preparePackagedPluginForLaunch(options, dependencies?): Promise<string>` returning the physical Profile plugin directory.

- [ ] **Step 1: Write failing startup-orchestration tests**

Use injected functions to assert exact sequencing and that the receipt is not completed after a provisioning failure:

```ts
const events: string[] = [];
const profileDir = "/user/dsh/profiles/web";
const profilePluginDir = "/user/dsh/profiles/web/node_modules/@senguoyun/dsh-arkme";
const preparation = {
  artifact: {
    artifactPath: "/user/dsh/arkme-self/plugin-seed/0.1.17/dsh-arkme.tgz",
    artifactSha512: "a".repeat(128),
    packageName: "@senguoyun/dsh-arkme" as const,
    version: "0.1.17"
  },
  profilePluginDir,
  resetRequired: true
};
const options = {
  resourcesPath: "/app/resources",
  dshHome: "/user/dsh",
  appVersion: "0.1.5",
  dshVersion: "0.1.0-rc.8",
  profileName: "web",
  packageManager: { executable: "/app/electron", prefixArgs: ["/app/pnpm.cjs"] }
};
const pluginDir = await preparePackagedPluginForLaunch(options, {
  prepareBootstrap: async () => { events.push("prepare"); return preparation; },
  provisionProfile: async () => {
    events.push("provision");
    return { profileDir, pluginDir: profilePluginDir, source: "embedded", version: "0.1.17" };
  },
  completeBootstrap: async () => { events.push("complete"); }
});
expect(pluginDir).toBe(profilePluginDir);
expect(events).toEqual(["prepare", "provision", "complete"]);
```

- [ ] **Step 2: Run startup tests and verify RED**

Run: `cd jotmo-harness && pnpm exec vitest run tests/plugin-startup.test.ts`

Expected: FAIL because `src/plugin-startup.ts` does not exist.

- [ ] **Step 3: Implement the orchestrator and main-process sequencing**

Export the Profile package-manager interface from `plugin-profile.ts`. Define `preparePackagedPluginForLaunch` options with `resourcesPath`, `dshHome`, `appVersion`, `dshVersion`, `profileName`, and `packageManager`. The optional dependency object has these exact keys:

```ts
interface PackagedPluginStartupDependencies {
  prepareBootstrap?: typeof preparePluginInstallBootstrap;
  provisionProfile?: typeof provisionArkmeWebProfile;
  completeBootstrap?: typeof completePluginInstallBootstrap;
}
```

In packaged startup:

1. Verify DSH and pnpm paths, but remove the pre-bootstrap `access(packagedPlugin/lib/index.js)` dependency.
2. Call `preparePluginInstallBootstrap` before Profile provisioning.
3. Call `provisionArkmeWebProfile` with `embeddedArtifact` and `forceEmbedded: preparation.resetRequired`.
4. Call `completePluginInstallBootstrap` only after provisioning succeeds.
5. Pass `provisioned.pluginDir` to `resolveManagedExtensionRestartPaths` so helpers load from the Profile.

Development startup keeps the existing source-directory behavior and does not create an installer receipt.

- [ ] **Step 4: Run build and startup-path tests**

Run: `cd jotmo-harness && pnpm run typecheck && pnpm exec vitest run tests/plugin-startup.test.ts tests/plugin-install-bootstrap.test.ts tests/plugin-profile.test.ts tests/runtime-path.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit only Task 4 files**

```bash
cd jotmo-harness
git add src/main.ts src/plugin-startup.ts tests/plugin-startup.test.ts src/plugin-profile.ts
git commit -m "fix: bootstrap packaged plugin from managed seed"
```

### Task 5: Make every NSIS install request a clean reset

**Files:**
- Create: `jotmo-harness/build/installer.nsh`
- Modify: `jotmo-harness/package.json:56`
- Modify: `jotmo-harness/tests/app-manifest.test.ts:35`

**Interfaces:**
- Consumes: Task 1 packaged files.
- Produces: NSIS post-extraction validation and receipt invalidation.

- [ ] **Step 1: Add failing manifest and installer-script tests**

Assert `build.extraResources` contains both node_modules and `arkme-plugin-seed`, `build.nsis.include` equals `build/installer.nsh`, and the include checks all four files before deleting only the bootstrap receipt:

```ts
expect(installer).toContain("@deepseek-ai\\dsh\\lib\\bin.js");
expect(installer).toContain("@senguoyun\\dsh-arkme\\lib\\index.js");
expect(installer).toContain("arkme-plugin-seed\\manifest.json");
expect(installer).toContain("arkme-plugin-seed\\dsh-arkme.tgz");
expect(installer).toContain("$APPDATA\\Arkme Harness\\dsh\\arkme-self\\desktop-plugin-bootstrap.json");
expect(installer).not.toContain("RMDir /r \"$APPDATA");
```

- [ ] **Step 2: Run the manifest test and verify RED**

Run: `cd jotmo-harness && pnpm exec vitest run tests/app-manifest.test.ts`

Expected: FAIL because the seed resource and NSIS include are not configured.

- [ ] **Step 3: Add the NSIS include and package configuration**

`customInstall` runs after electron-builder extracts application files. Use `IfFileExists`, `MessageBox MB_ICONSTOP|MB_OK`, and `Abort` for each required file. Only after every check succeeds, execute:

```nsh
Delete "$APPDATA\Arkme Harness\dsh\arkme-self\desktop-plugin-bootstrap.json"
```

Add:

```json
"nsis": { "include": "build/installer.nsh" }
```

and an `extraResources` entry from `.runtime/dsh/arkme-plugin-seed` to `arkme-plugin-seed`.

- [ ] **Step 4: Run manifest tests and an unpacked build when the host supports it**

Run: `cd jotmo-harness && pnpm exec vitest run tests/app-manifest.test.ts tests/runtime-plugin-seed.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit only Task 5 files**

```bash
cd jotmo-harness
git add build/installer.nsh package.json tests/app-manifest.test.ts
git commit -m "fix: reset core plugin on every Windows install"
```

### Task 6: Guard updater remove operations against legacy junctions

**Files:**
- Create: `arkme-dsh-plugin/src/profile-plugin-entry.ts`
- Create: `arkme-dsh-plugin/tests/profile-plugin-entry.test.ts`
- Modify: `arkme-dsh-plugin/src/plugin-updater-helper.ts:201`
- Modify: `arkme-dsh-plugin/src/plugin-update.ts:530`
- Modify: `arkme-dsh-plugin/tests/plugin-updater-helper.test.ts:1`
- Modify: `arkme-dsh-plugin/tests/plugin-update.test.ts:1`

**Interfaces:**
- Consumes: `dshHome` and validated single-segment `profileName`.
- Produces: `detachManagedProfilePluginLink(options): Promise<"missing" | "detached" | "directory">`.

- [ ] **Step 1: Write failing guard tests**

```ts
const result = await detachManagedProfilePluginLink({ dshHome, profileName: "web" });
expect(result).toBe("detached");
await expect(lstat(linkPath)).rejects.toMatchObject({ code: "ENOENT" });
expect(await readFile(targetSentinel, "utf8")).toBe("preserved");
```

Add tests returning `directory` for a physical package, `missing` for ENOENT, rejecting `../web`, rejecting a regular file, and preserving the target when called a second time.

- [ ] **Step 2: Run the guard test and verify RED**

Run: `cd arkme-dsh-plugin && pnpm exec vitest run tests/profile-plugin-entry.test.ts`

Expected: FAIL because `src/profile-plugin-entry.ts` does not exist.

- [ ] **Step 3: Implement the guard**

Derive the plugin path internally from `resolve(dshHome)/profiles/<profileName>/node_modules/@senguoyun/dsh-arkme`. Reject names that are empty, `.`/`..`, or contain `/` or `\\`. Use `lstat`; call `unlink` only for `isSymbolicLink()`, return `directory` only for `isDirectory()`, and throw for all other types.

- [ ] **Step 4: Integrate before every remove**

Make helper remove/rollback operations async where necessary. Call the guard immediately before each DSH `plugin remove` in:

- standalone `runTargetRemove`;
- standalone rollback cleanup;
- `ArkmePluginUpdateManager.runProfilePluginRemove`;
- supervised rollback cleanup through the same method.

Preserve all current lifecycle logging unchanged; do not expand `PluginUpdateLifecycleDetails` for the detach result.

- [ ] **Step 5: Run updater tests**

Run: `cd arkme-dsh-plugin && pnpm exec vitest run tests/profile-plugin-entry.test.ts tests/plugin-updater-helper.test.ts tests/plugin-update.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit only the updater safety files**

```bash
cd arkme-dsh-plugin
git add src/profile-plugin-entry.ts src/plugin-updater-helper.ts src/plugin-update.ts tests/profile-plugin-entry.test.ts tests/plugin-updater-helper.test.ts tests/plugin-update.test.ts
git commit -m "fix: detach legacy plugin junction before update"
```

### Task 7: Repair packaged smoke verification

**Files:**
- Modify: `jotmo-harness/scripts/packaged-smoke.mjs:1`
- Modify: `jotmo-harness/scripts/packaged-layout.mjs:15`
- Modify: `jotmo-harness/tests/packaged-layout.test.ts:6`

**Interfaces:**
- Consumes: `resolvePackagedSmokePlatform(process.argv.slice(2))` and `packagedAppLayout(projectRoot, platform)`.
- Produces: host-native Windows/Linux/macOS packaged verification including seed validation.

- [ ] **Step 1: Add a failing layout assertion for the seed directory**

Extend each expected layout with `pluginSeed`, such as:

```ts
pluginSeed: path.win32.join("C:/project", "release", "win-unpacked", "resources", "arkme-plugin-seed")
```

- [ ] **Step 2: Run layout tests and verify RED**

Run: `cd jotmo-harness && pnpm exec vitest run tests/packaged-layout.test.ts`

Expected: FAIL because layouts do not expose `pluginSeed` and packaged smoke still hardcodes macOS paths.

- [ ] **Step 3: Use the platform layout in packaged smoke**

Replace hardcoded `Contents/Resources` and `Contents/MacOS` paths with:

```js
const platform = resolvePackagedSmokePlatform(process.argv.slice(2));
const layout = packagedAppLayout(process.cwd(), platform);
const appRoot = process.env.ARKME_PACKAGED_APP_ROOT ?? layout.appRoot;
```

When `ARKME_PACKAGED_APP_ROOT` is set, derive the platform-specific resource paths from that root. Validate `manifest.json`, hash `dsh-arkme.tgz`, and compare it with `artifactSha512` before launching DSH.

- [ ] **Step 4: Run smoke-layout and manifest tests**

Run: `cd jotmo-harness && pnpm exec vitest run tests/packaged-layout.test.ts tests/app-manifest.test.ts tests/runtime-plugin-seed.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit only Task 7 files**

```bash
cd jotmo-harness
git add scripts/packaged-smoke.mjs scripts/packaged-layout.mjs tests/packaged-layout.test.ts
git commit -m "test: verify native packaged plugin seed layout"
```

### Task 8: Add the real Windows junction regression gate

**Files:**
- Create: `jotmo-harness/tests/windows-plugin-install-repair.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 bootstrap API and Task 3 Profile provisioning API with pinned pnpm.
- Produces: a Windows-only regression proving target preservation and reinstall idempotence.

- [ ] **Step 1: Write the Windows-only integration test**

Use `describe.skipIf(process.platform !== "win32")`. Create an embedded target with `lib/index.js` and a sentinel, create a real `junction` from Profile to that target, create a valid packed seed, remove the receipt to simulate NSIS, and run prepare/provision/complete. Assert:

```ts
expect(await readFile(path.join(embeddedTarget, "sentinel.txt"), "utf8")).toBe("keep");
expect(await readFile(path.join(embeddedTarget, "lib", "index.js"), "utf8")).toBe("embedded");
expect((await lstat(profilePluginDir)).isSymbolicLink()).toBe(false);
expect(JSON.parse(await readFile(path.join(profilePluginDir, "package.json"), "utf8")).version)
  .toBe("0.1.17");
```

Delete the receipt again and repeat the flow to prove same-version reinstall is idempotent.

- [ ] **Step 2: Run on the current host and verify a clean skip or pass**

Run: `cd jotmo-harness && pnpm exec vitest run tests/windows-plugin-install-repair.integration.test.ts`

Expected on macOS/Linux: one skipped suite, zero failures. Expected on Windows: PASS.

- [ ] **Step 3: Commit the Windows gate**

```bash
cd jotmo-harness
git add tests/windows-plugin-install-repair.integration.test.ts
git commit -m "test: protect Windows install target during plugin reset"
```

### Task 9: Full verification and release evidence

**Files:**
- Modify only if a verification failure exposes a defect in a file already listed above.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: passing build/test evidence and a verified distributable layout.

- [ ] **Step 1: Run full plugin verification**

Run: `cd arkme-dsh-plugin && pnpm run typecheck && pnpm test`

Expected: all tests pass with no TypeScript errors.

- [ ] **Step 2: Run full harness verification**

Run: `cd jotmo-harness && pnpm run typecheck && pnpm test && pnpm run build`

Expected: all tests pass, build exits 0, and pre-existing dirty supervisor tests remain intact.

- [ ] **Step 3: Prepare runtime and verify seed contents**

Run: `cd jotmo-harness && pnpm run prepare:runtime`

Expected: every architecture staging directory contains `arkme-plugin-seed/manifest.json` and `dsh-arkme.tgz`; the manifest hash equals the artifact SHA-512.

- [ ] **Step 4: Build the host-native unpacked application and run packaged smoke**

On Windows run: `cd jotmo-harness && pnpm run dist:win`

On macOS run: `cd jotmo-harness && pnpm run pack && ARKME_PACKAGED_APP_ROOT=release/mac-universal/arkme.app node scripts/packaged-smoke.mjs --platform darwin`

Expected: package creation and packaged smoke both pass. The Windows installer must contain `resources/arkme-plugin-seed/manifest.json`, `resources/arkme-plugin-seed/dsh-arkme.tgz`, and the normal runtime plugin `lib/index.js`.

- [ ] **Step 5: Record the remaining platform limitation without weakening the gate**

If verification runs on macOS, report that the Windows-only integration suite was skipped locally and must pass in Windows CI before release. Do not claim the NSIS repair is Windows-verified until that run exists.
