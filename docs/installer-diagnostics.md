# Desktop installer diagnostics

POST `/api/public/v1/arkme/installer-reports` is intentionally anonymous. It never establishes account identity or release authenticity. Requests have a 32 KiB cap and a strict schema; unknown fields, invalid dimensions and oversized text are rejected. Each process limits requests to 300/minute globally and 60/minute per resolved peer. Proxy addresses are resolved using the existing `analytics-sls-config.trusted-proxies` configuration; arbitrary forwarded headers are not trusted. Configure an ingress-wide limit when running multiple replicas.

Sentry uses `sentry-config.installer-dsn` if provided, otherwise the existing `sentry-config.dsn`. Use an installer-specific Sentry project when available. No DSN or a bad DSN returns 503, allowing the installer to retain a pending report. The endpoint does not require a login token or any secret embedded in an installer. Sentry events have a fresh isolated scope, no HTTP request/user/IP, the `desktop-installer@<version>+<build>` release, and fingerprint platform + stage + error code. Small sanitized logs are `installer.log` attachments. Anonymous submissions are tagged `source=anonymous-unverified` and can be spoofed; do not use them to authorize anything.

202 means accepted into a bounded asynchronous Sentry queue, not durable storage. Sentry/transport outages can still lose an accepted event; this is best-effort telemetry, not an audit log. Event IDs deduplicate retries within one process for 24 hours (maximum 10,000 entries). Multiple replicas/restarts do not share this cache. Sender retries reuse the same Sentry event ID. Delivery failures return 503 without marking the ID accepted.

## Payload (schema 1)

Fields: `schema`, `event_id` (32 hex chars; a random report ID, not a device ID), `platform` (`windows`/`macos`), `os_version`, `architecture`, `version`, `build`, `stage`, `result` (`success`/`failure`/`cancelled`), `error_code`, `recovery`, `scope`, `elapsed_ms`, `details`, `log`.

Text is redacted on-device before disk/network and again on the backend. Home-directory usernames are replaced with <user>; UNC server/share names and volume names are masked while preserving path structure. System/application paths, script names, line numbers, failure functions and adjacent error reasons remain readable. URLs, emails, IPv4 addresses, account strings, credential values and identity/authentication header values are redacted. Reapplying sanitization preserves the same result. Keep the raw error locally for manual support; uploads intentionally omit data that could identify a user. The diagnostic pipeline does not read application databases, recordings, chat messages, credentials or environment dumps. Full OS install logs are not collected. Event-body capture by the general Sentry HTTP middleware is disabled for this route so malformed requests cannot bypass the dedicated scrubber.

## Client behavior

- Windows: catch helper failures after recovery, then report from `finally`. Successful Check/Finalize/Rollback/UpdateCheck phases allow pending retries. A native NSIS failure uses a report-only helper and never enables manual rollback. Failures before the helper can run (OS blocks the EXE/PowerShell, user declines UAC, sudden power loss) cannot be reported immediately.
- macOS: the signed PKG helper reports after preflight/install result or recovery is determined. Signing/system Installer errors before this helper starts, force-quit/power loss, and ZIP updater failures are outside this first implementation.
- Upload attempts use fixed HTTPS endpoints with redirects disabled and a 1.5-second wait limit. Each invocation attempts at most two reports, so diagnostics may add at most roughly 3 seconds of network wait; installation/rollback results never depend on delivery.
- Queues contain only sanitized JSON: Windows `%LOCALAPPDATA%/Jiwo Installer Reports`, macOS `/Library/Application Support/cc.jiwo.installer/reports`. Retain at most 20 recognized reports for 7 days; retries occur on later installer execution. No daemon or application-start retry was added. A user who never runs the installer again may remain unreported when offline.
- Windows phases and macOS preflight/install have distinct report IDs. Count success only for Finalize/install; do not treat every phase event as a separate completed installation. Missing reports and cancellations are not reliable evidence of installation failure.

## Rollout

Deploy the backend route and Sentry configuration first, then build new signed installers. Existing published installers do not acquire this reporting code. Check the project's attachment quota/access and privacy disclosure before enabling broad release. Alert on new failure codes, regressions in a release and rollback failures; avoid alerts for successful checks or intentional cancellations. This change does not deploy services, create a Sentry project, or publish installers.
