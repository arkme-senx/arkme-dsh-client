import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

test.skipIf(process.platform !== "darwin")("macOS migration runs real file transactions, preserves data, and recovers failures", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jiwo-migration-test-")));
  try {
    const binary = path.join(root, "migration-tests");
    execFileSync("/usr/bin/xcrun", ["swiftc", "-module-cache-path", path.join(root, "modules"),
      "build/macos-migration/Migration.swift", "tests/fixtures/migration-macos/main.swift", "-o", binary],
      { timeout: 120_000, encoding: "utf8" });
    const run = spawnSync(binary, [root], { timeout: 30_000, encoding: "utf8" });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("44 migration scenarios passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 150_000);


test.skipIf(process.platform !== "darwin")("native installer compiles against generated release metadata for both macOS architectures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jiwo-installer-compile-"));
  try {
    const metadata = path.join(root, "ReleaseMetadata.swift");
    await writeFile(metadata, `enum ReleaseMetadata {
      static let appID = "cc.jiwo.arkme"
      static let minimumSystemVersion = "12.0"
      static let teamID = "TEAM"
      static let version = "3.0.0"
      static let build = 277
    }`);
    for (const arch of ["arm64", "x86_64"]) {
      execFileSync("/usr/bin/xcrun", ["swiftc", "-typecheck", "-target", `${arch}-apple-macos12.0`,
        "-module-cache-path", path.join(root, "modules"), "build/macos-migration/Migration.swift",
        "build/macos-migration/System.swift", "build/macos-migration/main.swift", metadata],
      { timeout: 120_000, encoding: "utf8" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 250_000);

test.skipIf(process.platform !== "darwin")("native signature verification is launched as a one-shot system service", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jiwo-signature-verifier-test-")));
  try {
    const binary = path.join(root, "signature-verifier-tests");
    execFileSync("/usr/bin/xcrun", ["swiftc", "-module-cache-path", path.join(root, "modules"),
      "build/macos-migration/Migration.swift", "build/macos-migration/System.swift",
      "tests/fixtures/macos-signature-verification/main.swift", "-o", binary],
    { timeout: 120_000, encoding: "utf8" });
    const run = spawnSync(binary, [], { timeout: 30_000, encoding: "utf8" });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("2 signature verification scenarios passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 150_000);
