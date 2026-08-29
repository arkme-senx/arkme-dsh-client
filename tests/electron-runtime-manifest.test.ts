import { describe, expect, test } from "vitest";
import {
  compareElectronRuntimeCandidate,
  deriveElectronRuntimeReleaseId,
  parseElectronRuntimeManifest,
  type ElectronRuntimeManifest
} from "../src/runtime/manifest.js";

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const document = {
    schemaVersion: 1,
    releaseId: "electron-runtime-v1-0123456789abcdef0123456789abcdef",
    channel: "stable",
    publishedAt: "2026-08-27T00:00:00Z",
    target: { os: "darwin", arch: "arm64" },
    minShellVersion: "0.2.0",
    runtimeApiVersion: 1,
    dataSchemaVersion: 1,
    electron: { major: 43, modulesAbi: 148 },
    pnpmVersion: "11.19.0",
    artifacts: {
      harness: {
        version: "0.1.0-rc.8",
        versionCode: 4,
        modulesAbi: 148,
        url: "https://d.jiwo.cc/harness.tar.zst",
        sha256: "a".repeat(64),
        size: 100,
        unpackedSize: 200,
        entry: "harness/node_modules/@deepseek-ai/dsh/lib/bin.js",
        metadata: "harness/runtime-metadata.json"
      },
      requiredPlugin: {
        version: "0.1.18",
        versionCode: 7,
        url: "https://d.jiwo.cc/plugin.tar.zst",
        sha256: "b".repeat(64),
        size: 50,
        unpackedSize: 80,
        name: "@senguoyun/dsh-arkme",
        target: "harness/node_modules/@senguoyun/dsh-arkme"
      }
    },
    ...overrides
  };
  if (overrides.releaseId === undefined) {
    document.releaseId = deriveElectronRuntimeReleaseId(document as ElectronRuntimeManifest);
  }
  return document;
}

const context = {
  os: "darwin",
  arch: "arm64",
  shellVersion: "0.2.0",
  electronMajor: 43,
  modulesAbi: 148
} as const;

describe("Electron runtime manifest", () => {
  test("accepts an Electron 43 release set containing only Harness and the shared plugin", () => {
    const parsed = parseElectronRuntimeManifest(manifest(), context);

    expect(parsed.artifacts.harness.versionCode).toBe(4);
    expect(parsed.artifacts.requiredPlugin.versionCode).toBe(7);
    expect(Object.keys(parsed.artifacts)).toEqual(["harness", "requiredPlugin"]);
  });

  test.each([
    ["wrong target", { target: { os: "darwin", arch: "x64" } }],
    ["wrong ABI", { electron: { major: 43, modulesAbi: 137 } }],
    ["future shell", { minShellVersion: "0.3.0" }],
    ["forged release identity", { releaseId: "electron-runtime-v1-ffffffffffffffffffffffffffffffff" }],
    ["plugin without managed-runtime mode", {
      artifacts: {
        ...(manifest().artifacts as Record<string, unknown>),
        requiredPlugin: {
          ...((manifest().artifacts as Record<string, unknown>).requiredPlugin as Record<string, unknown>),
          version: "0.1.17"
        }
      }
    }],
    ["untrusted artifact", {
      artifacts: {
        ...(manifest().artifacts as Record<string, unknown>),
        harness: {
          ...((manifest().artifacts as Record<string, unknown>).harness as Record<string, unknown>),
          url: "https://example.com/harness.tar.zst"
        }
      }
    }]
  ])("rejects %s", (_name, override) => {
    expect(() => parseElectronRuntimeManifest(manifest(override), context)).toThrow();
  });

  test("stages only a monotonically newer release and rejects equal-code identity conflicts", () => {
    const current = parseElectronRuntimeManifest(manifest(), context);
    const newer = structuredClone(current);
    newer.releaseId = "electron-runtime-v1-fedcba9876543210fedcba9876543210";
    newer.artifacts.harness.versionCode = 5;
    newer.artifacts.harness.sha256 = "c".repeat(64);
    expect(compareElectronRuntimeCandidate(current, newer)).toBe("newer");

    const conflict = structuredClone(current) as ElectronRuntimeManifest;
    conflict.releaseId = "electron-runtime-v1-11111111111111111111111111111111";
    conflict.artifacts.harness.sha256 = "d".repeat(64);
    expect(() => compareElectronRuntimeCandidate(current, conflict)).toThrow(/identity conflict/i);

    const stale = structuredClone(newer);
    stale.artifacts.requiredPlugin.versionCode = 6;
    expect(compareElectronRuntimeCandidate(current, stale)).toBe("stale");
  });
});
