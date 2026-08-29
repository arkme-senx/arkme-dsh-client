# Arkme Environment Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a side-by-side test Electron shell whose Arkme runtime, profile, data, identity, deep links, and updates are isolated from production.

**Architecture:** Resolve `prod | test` from the already trusted packaged runtime service origin. Thread that value through path resolution, profile provisioning, app identity, status rendering, and update setup while preserving every production default.

**Tech Stack:** TypeScript, Electron 43, Vitest, electron-builder, YAML profile patches.

**Spec:** `docs/superpowers/specs/2026-08-28-arkme-environment-isolation-design.md`

## Global Constraints

- Production root remains `Arkme Harness`; test root is `Arkme Harness Test`.
- Production identity remains `arkme`, `cc.jiwo.arkme`, and `arkme://`.
- Test identity is `arkme Test`, `cc.jiwo.arkme.test`, and `arkme-test://`.
- The same plugin artifact is used in both environments; no plugin API or manifest changes.
- App updates remain check, progress download, reveal file, and manual installation.
- Do not commit without the user's explicit commit confirmation; preserve all pre-existing dirty changes.

---

### Task 1: Runtime environment and isolated paths

**Files:**
- Modify: `src/runtime/service-config.ts`
- Modify: `src/settings.ts`
- Test: `tests/runtime-service-config.test.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Produce: `RuntimeEnvironment = "prod" | "test"` and a packaged config reader returning both environment and service origin.
- Produce: environment-aware user-data and app-update download path resolvers.

- [x] Add failing literal tests for prod/test origin mapping, rejection of untrusted origins, `Arkme Harness Test`, and isolated test update downloads.
- [x] Run the focused tests and confirm failures name the missing environment/path behavior.
- [x] Implement the minimum resolver changes while preserving production defaults.
- [x] Run the focused tests and confirm they pass.

### Task 2: Test-owned Arkme profile patch

**Files:**
- Modify: `src/plugin-profile.ts`
- Test: `tests/plugin-profile.test.ts`

**Interfaces:**
- Consume: `RuntimeEnvironment`.
- Extend: `ProvisionArkmeWebProfileOptions.environment?: RuntimeEnvironment`.
- Produce: atomic test patch installation; production keeps write-if-missing behavior.

- [x] Add failing tests proving the test patch contains the hand-checked test endpoints, repairs a modified test patch, and never rewrites a production patch.
- [x] Run the focused test and confirm it fails because test profile ownership is absent.
- [x] Add the fixed test patch template and atomic write path, defaulting omitted environment to production compatibility.
- [x] Run the focused tests and confirm they pass.

### Task 3: Environment-aware app identity, deep links, and updates

**Files:**
- Modify: `src/main.ts`
- Modify: `src/deep-link.ts`
- Modify: `scripts/copy-static.mjs`
- Add/modify: electron-builder test configuration and packaging scripts in `package.json`/`scripts`.
- Test: `tests/deep-link.test.ts`
- Test: `tests/app-update.test.ts`
- Test: `tests/app-manifest.test.ts`

**Interfaces:**
- Consume: the single resolved environment/service origin.
- Produce: environment-specific app name, app ID, deep-link scheme, runtime feed, app-update feed, and test update directory.

- [x] Add failing tests for `arkme-test://`, the test app identity, and test app-update feed selection.
- [x] Run the focused tests and confirm the existing production-only constants fail them.
- [x] Thread resolved environment through startup before `app.setPath`, protocol registration, profile provisioning, and app-update setup.
- [x] Add a test packaging configuration that overrides product name, app ID, protocol, and output without changing production manifest defaults.
- [x] Run the focused tests and confirm both environments pass.

### Task 4: Confirmed test-environment status UI

**Files:**
- Modify: `src/status-url.ts` and/or status state types.
- Modify: `src/ui/status.html` and its renderer inputs.
- Test: matching status URL/rendering tests.

**Interfaces:**
- Consume: `RuntimeEnvironment`.
- Produce: test-only `arkme Test`, `测试环境`, and `正在准备测试环境运行服务`; production rendering remains byte-for-byte equivalent in visible copy.

- [x] Add a failing renderer test for the approved low-fidelity copy and a production regression assertion.
- [x] Run it and confirm the test environment copy is absent.
- [x] Add environment fields to status rendering and test-only markup/styles using the existing visual system.
- [x] Run the focused rendering tests and confirm both variants pass.

### Task 5: Integration and regression verification

**Files:**
- Test: existing runtime, profile, packaging, update, and settings suites.

**Interfaces:**
- Verify all interfaces produced by Tasks 1-4 together.

- [x] Run focused Vitest suites for service config, settings, profile, deep link, update, status, and manifest behavior.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm test`.
- [x] Run `pnpm run build` and `pnpm run build:test`; inspect both generated runtime service configs.
- [ ] Run the unsigned macOS test packaging smoke flow if signing is not required for the check. (Packaging and test release download passed; Harness startup is blocked by mixed `0.1.1-rc.1`/`0.1.1-rc.2` dependencies in the currently published test Harness artifact.)
- [x] Review `git diff` to confirm no Arkme plugin, backend, production release-set, or user data changes were introduced.
