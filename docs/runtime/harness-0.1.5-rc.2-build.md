# Harness 0.1.5-rc.2 runtime build

The runtime workspace and desktop development dependencies resolve the official `@deepseek-ai/dsh@0.1.5-rc.2` graph. Electron stays at 43.2.0 (modules ABI 148), pnpm at 11.19.0. Harness remains a development dependency of the desktop shell and is not added to the installed app dependency closure.

The rc2 graph removes `dsh-client-runtime` and `dsh-host-apiproxy`. Do not alias the former to `dsh-client-test-runtime`: that package is test support. `.pnpmfile.cjs` pins runtime DSH dependencies, while leaving the retired type-only development dependency in the plugin's own Git build unchanged. The lockfile contains neither retired runtime package and every DSH runtime package is exactly rc2.

Production plugin provenance now points to the real 0.1.52 source commit `2838fdceea0e4702b9017a31e0ad6f0893fc823a`, including its actual tarball integrity and the regenerated rc2 peer snapshot fingerprints. The production source is not the unpublished readiness modification. Its existing UI layout/slot compatibility can be built from that commit.

## Production release gate

Runtime preparation requires the plugin package to declare `arkme.desktopHarnessReady.version: 1`. The currently published 0.1.52 source does not declare this capability, so a production runtime build fails explicitly. Before production release, publish the reviewed readiness change under its real version and immutable commit, update the production catalog, lockfile, build grants and complete fingerprint, then rebuild without a local override. No version or commit is fabricated by these scripts.

## Local candidate

Build the sibling plugin first, including its readiness change, then run from the client project:

```sh
ARKME_RUNTIME_LOCAL_PLUGIN_DIR=/absolute/path/to/arkme-dsh-plugin \
ARKME_RUNTIME_BUILD_ID=local-015rc2-ready-20260914 \
ARKME_RUNTIME_OUTPUT_DIR=/tmp/arkme-harness-015rc2-local \
pnpm run build:runtime:electron-harness
```

The explicit local directory replaces the staged plugin using its real publication files. Its version and built bytes are preserved. `PLUGIN_PROVENANCE.json` records `source: local`, a copied source-tree SHA256 (before routine debug-map/documentation pruning) and `releaseEligible: false`; it never claims a Git commit. The packed seed manifest independently hashes the final tarball with SHA512. Local artifact build IDs must begin with `local-`, and the output includes `LOCAL_CANDIDATE.json`. These are validation artifacts and must not be uploaded as a production release.

The app-boot patch preserves rc2's canonical symlink/junction comparison and adds only the required live `package.json` check. The real published entrypoint is checked in as a licensed test fixture, with tests for idempotence, relative live links and package-less fallback repair.

Native execution must be verified on each release target. A build on macOS can validate foreign binary presence and archive structure but cannot establish Windows/Linux execution compatibility.

## Real browser validation

```sh
pnpm exec electron scripts/runtime/real-browser-ready-smoke.cjs .runtime/dsh-arm64
```

This opt-in smoke compiles the current supervisor/preload/readiness helpers into a temporary directory, starts the actual prepared runtime, and opens a hidden sandboxed Electron BrowserWindow. All Electron userData, browser session data, DSH_HOME and workspace paths are temporary. It verifies the actual plugin readiness signal, clean authenticated navigation, HttpOnly-cookie invisibility, absent renderer Node globals, and denial of app-update privileges to the trial page using the real coordinator. The report is `/tmp/arkme-rc2-browser-ready-report.json`. This is local renderer/protocol verification; it does not exercise model calls, account login, signed installation or other operating systems.

## New client Version Code gate

The checked-in client currently has Version Code 6. Local release artifacts already used Code 6. The updater accepts only a strictly larger Code, and runtime compatibility selection is keyed by that Code. Allocate a new Code greater than the highest published value before release (7 only if the published maximum is still 6); do not reuse Code 6 for the migration. Register the rc2 compatibility rule for the newly allocated client Code, preserving older client rules. The local build validator enforces positive int32 format, not global allocation or monotonicity, so the release registry must confirm uniqueness and ordering. Keep the manifest Code, `vc{Code}` artifact names, update metadata and release record consistent and verify size/SHA512 before publishing.

## Runtime-free desktop package preflight

For local unsigned directory validation (not a distributable release):

```sh
pnpm run build
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac --arm64 --dir --publish never --config.mac.forceCodeSigning=false --config.mac.identity=null --config.directories.output=/tmp/arkme-rc2-runtime-free-desktop
node scripts/packaged-smoke.mjs --platform darwin --app-root /tmp/arkme-rc2-runtime-free-desktop/mac-arm64/arkme.app --preflight-only
```

Preflight checks ASAR/resources are runtime-free, the shipped epoch exists, the packaged updater initializes its real download cache, and the delivered preload works in an isolated Electron profile. It explicitly does **not** claim fresh dynamic activation or signed-install validation.

Full `packaged-smoke` derives the cache directory from the shipped epoch constant. In a fresh temporary profile it requires an active non-probation release plus ordered `runtime-candidate-complete` and clean `render-ready` evidence. Candidate completion in main follows authenticated plugin health and real page readiness. The external smoke does not extract cookies/tokens or make unauthenticated rc1-style API requests. Full activation still requires a published readiness-capable plugin and the correct service-side client Code rule.

On 2026-09-14, the arm64 unsigned directory package passed preflight. The current network-waiting screen was rendered from the built `createStatusPageUrl`, captured as `/tmp/arkme-network-waiting.png`, and visually inspected: approved title, preservation message, exactly **重试 / 打开日志**, and the network-recovery footer, with no clipping or extra recovery controls.

## Offline packaged main integration fixture

```sh
node scripts/runtime/packaged-offline-smoke.mjs /tmp/arkme-rc2-runtime-free-desktop/mac-arm64/arkme.app /tmp/arkme-harness-015rc2-local /tmp/arkme-rc2-plugin-artifact
```

This opt-in macOS arm64 smoke seeds a fresh temporary current-epoch acquisition record and both complete archives, verifying their actual sizes and SHA256. A rejecting proxy blocks external HTTP traffic. The synthetic compatibility Code values and non-existent remote URLs are explicitly local-only and not publishable. The script then launches the real packaged main twice and checks authenticated candidate completion, final page load without renderer errors, committed transaction state, deferred legacy-to-guest data preservation and identity transfer, unchanged old-epoch sentinel files, and same-container offline restart. The first isolated main is killed with SIGKILL to exercise orphan cleanup; the second stops normally. After each parent exits the smoke observes that both the recorded Harness PID and its process group disappear without killing them itself. The final report is `/tmp/arkme-packaged-offline-report.json`; detailed logs and fixture metadata remain under the temporary root recorded there.

This fixture validates local acquisition/recovery behavior; it does not validate a production feed, published compatibility rules, signed installation, authenticated account migration, model execution, or foreign-platform process behavior.

On 2026-09-14, the latest unsigned arm64 package passed the complete offline fixture, including both settled final pages without renderer errors and SIGKILL orphan-group cleanup. It used the unchanged rc2 Harness archive and corrected local plugin archive SHA256 `4a134599075896543ee4a8dc95d7b91fc4676e03a1a6a5426aba5aaacfa5b37f`. One completed transaction and the same guest container survived restart; five external requests were rejected by the proxy. The earlier stricter run exposed an undeclared `remote.session` injection in the model slot; the plugin correction and render-commit readiness were rebuilt before this successful rerun. These local plugin bytes remain unpublished.
