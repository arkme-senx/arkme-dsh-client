import { spawnSync } from "node:child_process";
import path from "node:path";
import { validateMacCodeSigningDetails } from "../dist/macos-signature.js";

const appPath = path.resolve(process.argv[2] ?? "release/mac-arm64/arkme.app");

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
console.log(`Verified signed Harness ${details.identifier} (TeamIdentifier=${details.teamIdentifier})`);
