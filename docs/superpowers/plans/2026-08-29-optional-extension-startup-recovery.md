# Optional Extension Startup Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the Electron shell to quarantine a failing optional DSH Bundle, retry the same runtime once, preserve core plugins, and expose the persistent quarantine to Arkme for user-visible manual recovery.

**Architecture:** `jotmo-harness` owns pre-Arkme failure classification and a crash-safe Profile transaction. `arkme-dsh-plugin` owns receipt reconciliation, extension state, host operations, and the confirmed recovery notice. The shell never opens the extension SQLite store, and the plugin never decides which Bundle prevented its own startup.

**Tech Stack:** TypeScript 6/5, Node.js filesystem APIs, Electron 43, React 18, Vitest 4, DSH Profile JSON.

**Spec:** `docs/superpowers/specs/2026-08-29-optional-extension-startup-recovery-design.md`

## Global Constraints

- Never quarantine `@senguoyun/dsh-arkme` or any `@deepseek-ai/*` package.
- A generic safe-mode fallback may disable only enabled optional dependencies whose spec starts with `link:` or `file:`.
- Do not delete dependencies, lockfiles, installed files, or source directories; only change `dsh.profile.bundles`.
- Retry the same runtime at most once per startup attempt.
- If the retry fails, restore the original Profile bytes before the error reaches runtime probation handling.
- A successful recovery must not mark or roll back the runtime release.
- Quarantine remains disabled until explicit user re-enable and restart.
- Production and test isolation is inherited from their distinct `DSH_HOME` roots; receipts must record the resolved environment.
- Preserve all pre-existing dirty changes and re-read target files before each patch because thread `01a04840-34ac-77e2-aaf3-979a8b8193b4` is concurrently editing runtime code.
- Do not commit or push while the concurrent worktree is dirty; completion is delivered as verified working-tree changes for later user-confirmed integration.

## File Structure

### `jotmo-harness`

- Create `src/optional-extension-recovery.ts`: parse the fixed web Profile, classify startup tails, create/activate/restore crash-safe quarantine transactions, and resume pending transactions.
- Create `tests/optional-extension-recovery.test.ts`: real-filesystem candidate, protection, atomicity, pending recovery, and environment-isolation coverage.
- Modify `src/harness-supervisor.ts`: invoke managed rollback first, then at most one optional-extension recovery retry, and record lifecycle events.
- Modify `tests/harness-supervisor.test.ts`: prove retry ordering, successful recovery, retry failure restoration, and no recovery loop.
- Modify `src/main.ts`: pass the already resolved environment and current runtime release ID into supervisor recovery configuration.

### `arkme-dsh-plugin`

- Create `src/extensions/desktop-quarantine.ts`: validate shell receipts, reconcile install-store state, list active entries, dismiss notices, request re-enable, and resolve entries after successful restart.
- Create `tests/extensions/desktop-quarantine.test.ts`: receipt validation, store convergence, dismissal, manual re-enable, multi-entry resolution, and prod/test-root separation.
- Modify `src/index.ts`: construct the quarantine manager after extension store/Profile installer creation and reconcile on startup.
- Modify `src/host-api.ts` and `src/types.ts`: add origin-protected status/dismiss/re-enable operations.
- Create `src/client/ArkmeExtensionRecoveryNotice.tsx`: render the confirmed single-extension and local-safe-mode notices.
- Create `tests/arkme-extension-recovery-notice.test.tsx`: verify user-facing reason, actions, dismissal, and manual re-enable/restart requests.
- Modify `src/client/ArkmePersistentShell.tsx`: mount the notice over the persistent workspace.
- Modify `src/client/ArkmeMarketplace.tsx`: project quarantined managed rows as “已自动停用” and route re-enable through the existing restart experience.

---

### Task 1: Build the crash-safe Profile recovery transaction

**Files:**
- Create: `jotmo-harness/src/optional-extension-recovery.ts`
- Create: `jotmo-harness/tests/optional-extension-recovery.test.ts`

**Interfaces:**
- Produces `prepareOptionalExtensionRecovery(input): Promise<OptionalExtensionRecoveryTransaction | undefined>`.
- Produces `activateOptionalExtensionRecovery(transaction): Promise<void>`.
- Produces `restoreOptionalExtensionRecovery(transaction): Promise<void>`.
- Produces `loadPendingOptionalExtensionRecovery(input): Promise<OptionalExtensionRecoveryTransaction | undefined>`.

- [ ] **Step 1: Write failing classification tests**

Use a real temporary `<DSH_HOME>/profiles/web/package.json` containing core bundles, one registry extension, two `link:`/`file:` extensions, and one disabled dependency. Assert these hand-derived outcomes:

```ts
expect(targeted?.receipt.mode).toBe("targeted");
expect(targeted?.receipt.entries.map(item => item.packageName)).toEqual([
  "@senguoyun/dsh-arkme-peer-portrait"
]);
expect(safeMode?.receipt.entries.map(item => item.packageName)).toEqual([
  "@example/local-a", "@example/local-b"
]);
expect(coreOnly).toBeUndefined();
expect(networkFailure).toBeUndefined();
```

The targeted fixture must mention a missing `@senguoyun/dsh-arkme` dependency and an importer path under the peer-portrait `link:` source, proving the optional importer is quarantined while the core dependency remains protected.

- [ ] **Step 2: Run and verify RED**

Run: `cd jotmo-harness && pnpm exec vitest run tests/optional-extension-recovery.test.ts`

Expected: FAIL because `src/optional-extension-recovery.ts` does not exist.

- [ ] **Step 3: Implement minimal classification and transaction code**

Use these public types:

```ts
export interface OptionalExtensionRecoveryConfig {
  dshHome: string;
  environment: "prod" | "test";
  runtimeReleaseId?: string;
}

export interface OptionalExtensionRecoveryTransaction {
  receiptPath: string;
  backupPath: string;
  receipt: DesktopExtensionQuarantineReceipt;
}
```

Implementation requirements:

- Read only `<dshHome>/profiles/web/package.json`.
- Validate npm-shaped package names and JSON object/array boundaries.
- Match exact package name, installed `node_modules/<package>` path, or normalized `link:`/`file:` source path in the failure tail.
- Require a module/Bundle loader failure signal before choosing candidates.
- Write a transaction directory atomically, including `receipt.json` and `profile-package.json.before`, before replacing the Profile.
- Write Profile and receipt updates by temporary file plus `rename`; retain file mode `0600` where supported.
- Cap sanitized `failureLogTail` at 16 KiB.
- Restore exact backup bytes and mark the receipt `restored` on failure.

- [ ] **Step 4: Add failing crash recovery tests and implement them**

Tests must prove a `pending` transaction with quarantined Profile is resumed, an incomplete transaction whose Profile was not changed is restored, dependencies and files remain untouched, and separate prod/test roots cannot see each other's receipts.

- [ ] **Step 5: Run Task 1 verification**

Run: `cd jotmo-harness && pnpm exec vitest run tests/optional-extension-recovery.test.ts`

Expected: PASS with zero failures.

### Task 2: Integrate one recovery attempt into the Harness supervisor

**Files:**
- Modify: `jotmo-harness/src/harness-supervisor.ts`
- Modify: `jotmo-harness/tests/harness-supervisor.test.ts`
- Modify: `jotmo-harness/src/main.ts`

**Interfaces:**
- Consumes Task 1 transaction functions through an injectable `optionalExtensionRecovery` dependency for deterministic supervisor tests.
- Extends `SupervisorConfig` with `optionalExtensionRecovery?: OptionalExtensionRecoveryConfig`.

- [ ] **Step 1: Write failing supervisor tests**

Cover four observable flows:

1. First spawn fails with an optional Bundle tail, Profile is quarantined, second spawn becomes ready, and final state is `ready`.
2. Both spawns fail, original Profile bytes are restored, and final state is `failed`.
3. A pending managed restart plan rolls back before optional recovery is attempted.
4. A non-loader failure spawns once and never modifies Profile.

Assert real Profile/receipt side effects rather than only mock invocation counts.

- [ ] **Step 2: Run and verify RED**

Run: `cd jotmo-harness && pnpm exec vitest run tests/harness-supervisor.test.ts`

Expected: new recovery cases FAIL because supervisor does not call the recovery transaction.

- [ ] **Step 3: Implement supervisor ordering and lifecycle logging**

Refactor the launch catch into a bounded flow: managed rollback, optional recovery prepare/resume, one launch retry, activate on success, restore on failure. Emit the five lifecycle event names from the spec through a supervisor-level log writer that remains usable after the failed child log closes.

- [ ] **Step 4: Pass environment/release identity from main**

Re-read `src/main.ts` immediately before patching. Use the existing resolved `runtimeServiceConfig.environment` and the actual prepared release ID; do not add another environment source or URL. If the concurrent thread changed these names, adapt to its final API without reverting its transaction work.

- [ ] **Step 5: Run Task 2 verification**

Run: `cd jotmo-harness && pnpm exec vitest run tests/optional-extension-recovery.test.ts tests/harness-supervisor.test.ts`

Expected: PASS with zero failures.

### Task 3: Reconcile quarantine receipts inside Arkme

**Files:**
- Create: `arkme-dsh-plugin/src/extensions/desktop-quarantine.ts`
- Create: `arkme-dsh-plugin/tests/extensions/desktop-quarantine.test.ts`
- Modify: `arkme-dsh-plugin/src/index.ts`

**Interfaces:**
- Produces class `ArkmeDesktopExtensionQuarantine` with `reconcile()`, `status()`, `dismiss(packageName)`, `reenable(packageName)`, `health(packageName)`, and `resolveActive()`.
- Consumes `ArkmeExtensionInstallStore` and a narrow Profile controller with `setEnabled()` and `restart()`.

- [ ] **Step 1: Write failing receipt/store reconciliation tests**

Use real receipt files and a temporary real install store. Assert that `phase=active` entries matching `profilePackageName` become `enabled=false`, `active=false`, and receive the Chinese failure summary. Assert malformed receipts, protected package entries, path escapes, wrong schema, and non-active phases are ignored or rejected without store mutation.

- [ ] **Step 2: Run and verify RED**

Run: `cd arkme-dsh-plugin && pnpm exec vitest run tests/extensions/desktop-quarantine.test.ts`

Expected: FAIL because the quarantine module does not exist.

- [ ] **Step 3: Implement receipt validation and state convergence**

Read receipts only from `<DSH_HOME>/arkme-self/desktop-extension-quarantine/<id>/receipt.json`. Never trust receipt paths or package names. Mark `synchronizedAtMillis` after store convergence; status returns active unsolved entries even when no install-store row exists.

- [ ] **Step 4: Implement explicit re-enable and resolution**

`reenable(packageName)` must require an active receipt entry, persist `reenableRequestedAtMillis`, use `setEnabled(packageName, true)`, and request a schema 4 supervised quarantine activation restart. `health(packageName)` checks both loader and Profile state after the restart; it writes `resolvedAtMillis` only for an explicitly requested and actually active package, and changes receipt phase to `resolved` only when all entries resolve. Dismissal only writes `notificationDismissedAtMillis`.

- [ ] **Step 5: Wire startup reconciliation in `src/index.ts`**

Re-read the concurrently modified file. Construct the quarantine manager after the install store and Profile installer exist and call `reconcile()` before exposing the extension manager. Loader resolution is finalized through the schema 4 helper health operation so an ordinary cold start cannot silently resolve a receipt. Do not alter update-manager environment behavior.

- [ ] **Step 6: Run Task 3 verification**

Run: `cd arkme-dsh-plugin && pnpm exec vitest run tests/extensions/desktop-quarantine.test.ts tests/extensions/profile-restart-helper.test.ts`

Expected: PASS with zero failures.

### Task 4: Expose protected quarantine operations and the confirmed UI

**Files:**
- Modify: `arkme-dsh-plugin/src/host-api.ts`
- Modify: `arkme-dsh-plugin/src/types.ts`
- Create: `arkme-dsh-plugin/src/client/ArkmeExtensionRecoveryNotice.tsx`
- Create: `arkme-dsh-plugin/tests/arkme-extension-recovery-notice.test.tsx`
- Modify: `arkme-dsh-plugin/src/client/ArkmePersistentShell.tsx`
- Modify: `arkme-dsh-plugin/src/client/ArkmeMarketplace.tsx`

**Interfaces:**
- Add host operations `extensions.quarantine.status`, `extensions.quarantine.dismiss`, `extensions.quarantine.reenable`, and helper-only `extensions.quarantine.health`.
- Add client view type containing mode, failure summary, package names, dismissed state, and log path availability.

- [ ] **Step 1: Write failing host-operation tests**

Assert status is read-only, while dismiss and re-enable reject originless requests and delegate only validated package names already present in an active receipt.

- [ ] **Step 2: Implement host operations and types**

Extend the host dispatcher with a narrow quarantine-manager interface. Add dismiss/re-enable to the existing origin-required mutation set. Do not accept DSH Home, receipt path, environment, runtime ID, or log path from Renderer params.

- [ ] **Step 3: Write failing React notice tests**

Render single and multi-entry fixtures with `react-test-renderer`. Assert exact user outcomes: “已安全启动”, “已进入本地扩展安全模式”, package names, clear failure reason, “打开扩展管理”, “查看详细原因/打开日志”, “重新启用并重启”, and “知道了”. Exercise button callbacks and API result transitions.

- [ ] **Step 4: Implement and mount the notice**

Create an accessible recovery overlay matching the approved low-fidelity prototype. Poll status once on persistent workspace mount, dismiss without changing quarantine, open the existing marketplace/extensions surface, and expand the sanitized failure tail in place for details. Do not introduce a new design system or environment switch.

- [ ] **Step 5: Project quarantine state in extension management**

For install-store-backed rows, show “已自动停用” and the receipt failure summary. For receipt-only local rows, include them in the recovery notice/detail list with re-enable action even if they are absent from catalog/store. Re-enable always triggers the supervised restart path.

- [ ] **Step 6: Run Task 4 verification**

Run: `cd arkme-dsh-plugin && pnpm exec vitest run tests/arkme-extension-recovery-notice.test.tsx tests/host-api.test.ts tests/arkme-marketplace.test.tsx`

If the repository uses differently named existing host/marketplace tests, run the matching files returned by `rg --files tests | rg 'host-api|marketplace'`.

Expected: PASS with zero failures.

### Task 5: Cross-repository regression and completion checks

**Files:**
- Verify all modified files from Tasks 1–4.

- [ ] **Step 1: Re-read concurrent thread state and target diffs**

Inspect thread `01a04840-34ac-77e2-aaf3-979a8b8193b4`, then run `git diff` for every touched file. Resolve only overlapping semantic changes and preserve its runtime state/Profile transaction work.

- [ ] **Step 2: Run focused harness regression**

Run:

```bash
cd jotmo-harness
pnpm exec vitest run tests/optional-extension-recovery.test.ts tests/harness-supervisor.test.ts tests/electron-runtime-manager.test.ts tests/plugin-profile.test.ts tests/runtime-service-config.test.ts
pnpm run typecheck
```

- [ ] **Step 3: Run focused Arkme regression**

Run:

```bash
cd arkme-dsh-plugin
pnpm exec vitest run tests/extensions/desktop-quarantine.test.ts tests/extensions/profile-restart-helper.test.ts tests/arkme-extension-recovery-notice.test.tsx
pnpm run typecheck
```

- [ ] **Step 4: Run full test suites and builds**

Run both repositories' `pnpm test` and `pnpm run build`. If local loopback tests fail with sandbox `EPERM`, rerun the same commands with the already established local-network permission and distinguish infrastructure errors from assertions.

- [ ] **Step 5: Verify original failure end-to-end with fixtures**

Start a fixture Profile containing a broken `link:` peer-portrait extension whose importer cannot resolve Arkme. Verify the first Harness process exits, the Profile loses only peer-portrait, the same runtime starts, the receipt is active, and the release state contains no new Bad entry. Then verify manual re-enable remains disabled after a failed restart.

- [ ] **Step 6: Inspect final working-tree changes without committing**

Run `git diff --check`, list exact files changed by this feature, and report any concurrent changes that remain unverified. Do not stage, commit, push, publish, or build release installers unless the user separately requests those actions.
