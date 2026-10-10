import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parse } from "yaml";
import {
  validateMacCodeSigningDetails,
  validateMacHelperIdentifiers,
  validateMacLocationUsageDescriptions,
  validateMacMainProcessEntitlements
} from "../dist/macos-signature.js";

const appPath = path.resolve(process.argv[2] ?? "release/mac-universal/即我.app");
const { assertAppUpdateConfig } = createRequire(import.meta.url)("./ensure-app-update-config.cjs");
assertAppUpdateConfig(parse(await readFile(path.join(appPath, "Contents", "Resources", "app-update.yml"), "utf8")));
const appExecutable = path.join(
  appPath,
  "Contents",
  "MacOS",
  "arkme"
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
const frameworks = path.join(appPath, "Contents/Frameworks");
const helperIdentifiers = [];
for (const entry of await readdir(frameworks, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
  const helper = path.join(frameworks, entry.name);
  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", helper], { encoding: "utf8" });
  const identifier = /^Identifier=(.+)$/m.exec(`${result.stdout ?? ""}${result.stderr ?? ""}`)?.[1]?.trim();
  if (result.error || result.status !== 0 || !identifier
    || identifier !== readPlistString(path.join(helper, "Contents/Info.plist"), "CFBundleIdentifier").trim()) {
    throw new Error(`Invalid signed Helper identity: ${entry.name}`);
  }
  helperIdentifiers.push(identifier);
}
validateMacHelperIdentifiers(helperIdentifiers);
const entitlementInspection = spawnSync(
  "/usr/bin/codesign",
  ["-d", "--entitlements", ":-", appPath],
  { encoding: "utf8" }
);
if (entitlementInspection.error !== undefined || entitlementInspection.status !== 0) {
  const detail = `${entitlementInspection.stdout ?? ""}${entitlementInspection.stderr ?? ""}`.trim();
  throw new Error(`Unable to inspect Harness entitlements: ${detail || entitlementInspection.error?.message}`);
}
validateMacMainProcessEntitlements(
  `${entitlementInspection.stdout ?? ""}${entitlementInspection.stderr ?? ""}`
);

const infoPlist = path.join(appPath, "Contents", "Info.plist");
validateMacLocationUsageDescriptions({
  location: readPlistString(infoPlist, "NSLocationUsageDescription"),
  whenInUse: readPlistString(infoPlist, "NSLocationWhenInUseUsageDescription")
});

verifyNestedNativeModule(notificationPermissionModule, appExecutable);
for (const [tool, args] of [
  ["/usr/bin/xcrun", ["stapler", "validate", appPath]],
  ["/usr/sbin/spctl", ["--assess", "--type", "execute", appPath]],
]) {
  const result = spawnSync(tool, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`Production application notarization validation failed: ${result.stderr || result.stdout || result.error?.message}`);
  }
}
console.log(
  `Verified signed Harness ${details.identifier} `
  + `(TeamIdentifier=${details.teamIdentifier}, CoreLocation=enabled, notification-permission=enabled)`
);

function readPlistString(plistPath, key) {
  const inspection = spawnSync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", plistPath],
    { encoding: "utf8" }
  );
  if (inspection.error !== undefined || inspection.status !== 0) {
    const detail = `${inspection.stdout ?? ""}${inspection.stderr ?? ""}`.trim();
    throw new Error(`Unable to read ${key} from Harness Info.plist: ${detail || inspection.error?.message}`);
  }
  return inspection.stdout ?? "";
}

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
  const frameworkArchitectures = inspectArchitectures(path.join(appPath, "Contents/Frameworks/Electron Framework.framework/Electron Framework"));
  if (appArchitectures !== "arm64 x86_64" || frameworkArchitectures !== "arm64 x86_64") {
    throw new Error(`Production macOS releases must be Universal; found app=${appArchitectures}, framework=${frameworkArchitectures}`);
  }
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
