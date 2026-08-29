# Arkme Environment Isolation Design

## Goal

Keep the production Electron shell unchanged while providing a side-by-side test shell whose runtime releases, DSH profile, Arkme state, credentials, extensions, settings, logs, and app updates use only the test environment.

## Architecture

The packaged runtime service origin is the single environment selector. `https://api.jotmo.cc` resolves to `prod`; `https://jotmo.senguo.me` resolves to `test`; all other origins remain rejected. The production shell keeps `Arkme Harness`, `arkme`, `cc.jiwo.arkme`, and `arkme://`. The test shell uses `Arkme Harness Test`, `arkme Test`, `cc.jiwo.arkme.test`, and `arkme-test://`.

Both environments use the same Arkme plugin artifact. Production preserves the plugin bundle patch and any existing profile patch. The test shell owns its isolated profile patch and atomically rewrites it on startup with test service origins, `environment: test`, production access disabled, plugin self-update disabled, and extension publishing disabled.

The runtime manager and app updater consume the same resolved service origin. Test app updates use the test backend feed and an isolated download directory. The supported app-update targets remain darwin/arm64, win32/x64, and linux/x64; installation remains manual after download.

## User Experience

Production UI remains unchanged. Test status pages and window identity show `arkme Test` and `测试环境`; startup copy says `正在准备测试环境运行服务`. The test app can coexist with production and cannot register the production deep-link scheme.

## Safety and Compatibility

There is no migration or copy between production and test roots. Existing production profile patches are never overwritten. No Arkme plugin public API, release-set manifest, plugin version, or backend route changes are required. The shared `d.jiwo.cc` origin is permitted only for signed artifact delivery.

## Acceptance

Tests must prove origin-to-environment mapping, isolated data and update paths, deterministic test profile repair, production patch preservation, environment-specific app identity and deep links, and environment-specific runtime/app-update feeds. Packaging checks must validate the test identity without changing production manifest defaults.
