import { spawnSync } from "node:child_process";
import path from "node:path";
import { validateMacCodeSigningDetails } from "../dist/macos-signature.js";

const appPath = path.resolve(process.argv[2] ?? "release/mac-arm64/arkme.app");
const appExecutable = path.join(
  appPath,
  "Contents",
  "MacOS",
  path.basename(appPath, ".app")
);
const notificationPermissionModule = path.join(
  appPath,
  "Contents",
  "Resources",
  "app.asar.unpacked",
  "node_modules",
  "@arkme",
  "macos-notification-permission",
  "build",
  "Release",
  "arkme_notification_permission.node"
);

const verification = spawnSync(
  "/usr/bin/codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appPath],
  { encoding: "utf8" }
);
if (verification.error !== undefined || verification.status !== 0) {
  const detail = `${verification.stdout ?? ""}${verification.stderr ?? ""}`.trim();
  throw new Error(`Harness macOS signature verification failed: ${detail || verification.error?.message}`);
}

const inspection = spawnSync(
  "/usr/bin/codesign",
  ["-dv", "--verbose=4", appPath],
  { encoding: "utf8" }
);
if (inspection.error !== undefined || inspection.status !== 0) {
  const detail = `${inspection.stdout ?? ""}${inspection.stderr ?? ""}`.trim();
  throw new Error(`Unable to inspect Harness macOS signature: ${detail || inspection.error?.message}`);
}

const details = validateMacCodeSigningDetails(`${inspection.stdout ?? ""}${inspection.stderr ?? ""}`);
verifyNestedNativeModule(notificationPermissionModule, appExecutable);
console.log(`Verified signed Harness ${details.identifier} (TeamIdentifier=${details.teamIdentifier})`);

function verifyNestedNativeModule(modulePath, executablePath) {
  const moduleVerification = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--verbose=2", modulePath],
    { encoding: "utf8" }
  );
  if (moduleVerification.error !== undefined || moduleVerification.status !== 0) {
    const detail = `${moduleVerification.stdout ?? ""}${moduleVerification.stderr ?? ""}`.trim();
    throw new Error(`macOS notification permission module signature is invalid: ${detail}`);
  }

  const appArchitectures = inspectArchitectures(executablePath);
  const moduleArchitectures = inspectArchitectures(modulePath);
  if (appArchitectures !== moduleArchitectures) {
    throw new Error(
      `macOS notification permission module architectures ${moduleArchitectures} `
      + `do not match application architectures ${appArchitectures}`
    );
  }
}

function inspectArchitectures(targetPath) {
  const inspection = spawnSync("/usr/bin/lipo", ["-archs", targetPath], { encoding: "utf8" });
  if (inspection.error !== undefined || inspection.status !== 0) {
    const detail = `${inspection.stdout ?? ""}${inspection.stderr ?? ""}`.trim();
    throw new Error(`Unable to inspect macOS architectures for ${targetPath}: ${detail}`);
  }
  return inspection.stdout.trim().split(/\s+/u).sort().join(" ");
}
