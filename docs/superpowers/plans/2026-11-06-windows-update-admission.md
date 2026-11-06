# Windows update admission implementation plan

Goal: Detect unsupported Windows native updates before downloads and before exiting the app, using the installer identity rules. Reuse the approved full-installer notice and existing telemetry.

Approved design: user confirmed the prototype in this chat. Normal registered modern installs continue auto update; missing registration, legacy identity or failed inspection offers the website and keeps the app running. Do not relax installer safeguards or auto-repair registry entries. No package publication in this task.

Architecture: add a read-only InspectUpdate action to the existing production migration helper. Package that same helper in dist. A bounded Windows PowerShell adapter returns structured eligibility to the update controller. Recheck immediately before the install callback (receipt/cleanup/quit). Test channels and non-Windows retain their route.

- [x] Add failing controller regressions for initial rejection, eligibility lost after download, exceptions, and eligible install.
- [x] Add InspectUpdate: detect owning registry scope, reuse installed signature/version/identity and legacy checks, validate trusted committed journals without cleanup (reject unfinished, unknown or missing records), inspect shortcuts without writes. Return machine-readable reason; no transcript, upload, process close or registry mutation.
- [x] Add adapter, packaging copy, controller integration and approved notice copy. Probe failure must fail closed to manual installation.
- [x] Run relevant native tests/typecheck/build, then Windows tests with real signed modern/legacy executables and isolated registry. Verify no quit/receipt/installer launch on rejection; verify normal path remains usable.
- [x] Review diff, verify latest remote dev, commit only task files with 功能点: and fast-forward push dev. Preserve existing logging and all user data.

Review focus: concurrent metadata check during install; installation state changes after download; missing or malformed helper output; test channel isolation; read-only handling of existing migration journals.

Validation: 161 related local tests pass (17 Windows/opt-in skips), typecheck and full build pass, real Electron notice/IPC smoke passes. Windows live signed PE/controller matrix and recovery/diagnostic/cancellation fixtures recorded in the automation evidence. Independent review found committed-journal compatibility; addressed with read-only shared validation and regression tests.
