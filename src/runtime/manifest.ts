import { createHash } from "node:crypto";
import semver from "semver";
import { RuntimeArtifactValidationError } from "./errors.js";

export interface ElectronRuntimeArtifact {
  version: string;
  versionCode: number;
  modulesAbi?: number;
  url: string;
  sha256: string;
  size: number;
  unpackedSize: number;
  entry?: string;
  metadata?: string;
  name?: string;
  target?: string;
}

export interface ElectronRuntimeManifest {
  schemaVersion: 1;
  releaseId: string;
  channel: "stable";
  publishedAt: string;
  target: { os: string; arch: string };
  minShellVersion: string;
  runtimeApiVersion: 1;
  dataSchemaVersion: 1;
  electron: { major: 43; modulesAbi: 148 };
  pnpmVersion: string;
  artifacts: {
    harness: ElectronRuntimeArtifact & { modulesAbi: 148; entry: string; metadata: string };
    requiredPlugin: ElectronRuntimeArtifact & { name: "@senguoyun/dsh-arkme"; target: string };
  };
}

export interface ElectronRuntimeContext {
  os: string;
  arch: string;
  shellVersion: string;
  electronMajor: number;
  modulesAbi: number;
}

export type CandidateDecision = "current" | "newer" | "stale";

const RELEASE_ID = /^electron-runtime-v1-[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 12 * 1024 * 1024 * 1024;

export function isElectronRuntimeReleaseId(value: unknown): value is string {
  return typeof value === "string" && RELEASE_ID.test(value);
}

export function parseElectronRuntimeManifest(
  document: unknown,
  context: ElectronRuntimeContext
): ElectronRuntimeManifest {
  const root = objectValue(document, "manifest");
  const target = objectValue(root.target, "target");
  const electron = objectValue(root.electron, "electron");
  const artifacts = objectValue(root.artifacts, "artifacts");
  if (
    root.schemaVersion !== 1
    || root.channel !== "stable"
    || root.runtimeApiVersion !== 1
    || root.dataSchemaVersion !== 1
    || !isElectronRuntimeReleaseId(root.releaseId)
    || typeof root.publishedAt !== "string"
    || !Number.isFinite(Date.parse(root.publishedAt))
    || typeof root.minShellVersion !== "string"
    || semver.valid(root.minShellVersion) === null
    || semver.valid(context.shellVersion) === null
    || semver.gt(root.minShellVersion, context.shellVersion)
    || target.os !== context.os
    || target.arch !== context.arch
    || electron.major !== 43
    || electron.modulesAbi !== 148
    || electron.major !== context.electronMajor
    || electron.modulesAbi !== context.modulesAbi
    || root.pnpmVersion !== "11.19.0"
  ) {
    throw new RuntimeArtifactValidationError("MANIFEST_INCOMPATIBLE", "Electron runtime manifest is incompatible with this shell", "manifest");
  }
  const artifactKeys = Object.keys(artifacts).sort();
  if (artifactKeys.join(",") !== "harness,requiredPlugin") {
    throw new RuntimeArtifactValidationError("MANIFEST_ARTIFACT_SET_INVALID", "Electron runtime manifest must contain only Harness and requiredPlugin", "manifest");
  }
  const harness = parseArtifact(artifacts.harness, "harness");
  const plugin = parseArtifact(artifacts.requiredPlugin, "requiredPlugin");
  if (
    harness.modulesAbi !== 148
    || harness.entry !== "harness/node_modules/@deepseek-ai/dsh/lib/bin.js"
    || harness.metadata !== "harness/runtime-metadata.json"
    || plugin.name !== "@senguoyun/dsh-arkme"
    || plugin.target !== "harness/node_modules/@senguoyun/dsh-arkme"
    || typeof plugin.version !== "string"
    || semver.lt(plugin.version, "0.1.18")
  ) {
    throw new RuntimeArtifactValidationError("ARTIFACT_IDENTITY_INVALID", "Electron runtime artifact identity is invalid", "manifest");
  }
  const manifest = root as unknown as ElectronRuntimeManifest;
  if (manifest.releaseId !== deriveElectronRuntimeReleaseId(manifest)) {
    throw new RuntimeArtifactValidationError("RELEASE_IDENTITY_MISMATCH", "Electron runtime release identity does not match its artifact set", "manifest");
  }
  return manifest;
}

export function deriveElectronRuntimeReleaseId(manifest: ElectronRuntimeManifest): string {
  const identity = `${manifest.target.os}/${manifest.target.arch}`
    + `|${manifest.artifacts.harness.versionCode}|${manifest.artifacts.harness.sha256}`
    + `|${manifest.artifacts.requiredPlugin.versionCode}|${manifest.artifacts.requiredPlugin.sha256}`;
  return `electron-runtime-v1-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

export function compareElectronRuntimeCandidate(
  current: ElectronRuntimeManifest,
  candidate: ElectronRuntimeManifest
): CandidateDecision {
  const pairs = [
    [current.artifacts.harness, candidate.artifacts.harness],
    [current.artifacts.requiredPlugin, candidate.artifacts.requiredPlugin]
  ] as const;
  if (pairs.some(([active, next]) => next.versionCode < active.versionCode)) return "stale";
  for (const [active, next] of pairs) {
    if (next.versionCode === active.versionCode && (
      next.sha256 !== active.sha256
      || next.version !== active.version
      || next.url !== active.url
    )) {
      throw new RuntimeArtifactValidationError("VERSION_CODE_IDENTITY_CONFLICT", "Electron runtime versionCode identity conflict", "manifest");
    }
  }
  return pairs.some(([active, next]) => next.versionCode > active.versionCode)
    ? "newer"
    : "current";
}

function parseArtifact(value: unknown, label: string): Record<string, unknown> {
  const artifact = objectValue(value, label);
  if (
    typeof artifact.version !== "string"
    || semver.valid(artifact.version) === null
    || !positiveInteger(artifact.versionCode)
    || typeof artifact.url !== "string"
    || !trustedArtifactURL(artifact.url)
    || typeof artifact.sha256 !== "string"
    || !SHA256.test(artifact.sha256)
    || !positiveInteger(artifact.size)
    || artifact.size > MAX_ARTIFACT_BYTES
    || !positiveInteger(artifact.unpackedSize)
    || artifact.unpackedSize > MAX_UNPACKED_BYTES
  ) {
    throw new RuntimeArtifactValidationError("ARTIFACT_DESCRIPTOR_INVALID", `Electron runtime ${label} artifact is invalid`, "manifest");
  }
  return artifact;
}

function trustedArtifactURL(rawURL: string): boolean {
  try {
    const url = new URL(rawURL);
    return url.protocol === "https:"
      && url.hostname === "d.jiwo.cc"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeArtifactValidationError("MANIFEST_OBJECT_INVALID", `Electron runtime ${label} must be an object`, "manifest");
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
