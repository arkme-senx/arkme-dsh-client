import { isElectronRuntimeReleaseId } from "./manifest.js";
import type { RuntimeEnvironment } from "./service-config.js";

export type RuntimeFailurePhase =
  | "manifest"
  | "download"
  | "verify"
  | "install"
  | "profile"
  | "harness-start"
  | "workspace-registration"
  | "plugin-health"
  | "unknown";

export type RuntimeFailureScope =
  | "artifact"
  | "network"
  | "environment"
  | "profile"
  | "workspace"
  | "user"
  | "unknown";

export interface RuntimeLaunchFailureInput {
  phase: RuntimeFailurePhase;
  scope: RuntimeFailureScope;
  code: string;
  reason: string;
  occurredAt: string;
}

export interface RuntimeLaunchFailure extends RuntimeLaunchFailureInput {
  releaseId: string;
  retryable: true;
  legacyUnclassified?: true;
}

export interface BadRuntimeRelease {
  releaseId: string;
  code: string;
  reason: string;
  failedAt: string;
}

export interface RuntimeInstallState {
  schemaVersion: 2;
  environment: RuntimeEnvironment;
  activeReleaseId?: string;
  previousReleaseId?: string;
  candidateReleaseId?: string;
  candidateAttemptedAt?: string;
  badReleases: BadRuntimeRelease[];
  deferredReleases: RuntimeLaunchFailure[];
  launchFailures: RuntimeLaunchFailure[];
  lastError?: { message: string; occurredAt: string };
}

interface LegacyRuntimeInstallState {
  schemaVersion: 1;
  activeReleaseId?: string;
  previousReleaseId?: string;
  pendingReleaseId?: string;
  probationReleaseId?: string;
  badReleases: Array<{ releaseId: string; reason: string; failedAt: string }>;
  lastError?: { message: string; occurredAt: string };
}

export function createEmptyRuntimeState(
  environment: RuntimeEnvironment = "prod"
): RuntimeInstallState {
  return {
    schemaVersion: 2,
    environment,
    badReleases: [],
    deferredReleases: [],
    launchFailures: []
  };
}

export function beginRuntimeCandidate(
  state: RuntimeInstallState,
  releaseId: string
): void {
  if (state.candidateReleaseId !== undefined) {
    throw new Error("An Electron runtime candidate is already pending validation");
  }
  if (state.activeReleaseId === releaseId) {
    throw new Error("The active Electron runtime release cannot also be a candidate");
  }
  state.candidateReleaseId = releaseId;
  delete state.candidateAttemptedAt;
}

export function markRuntimeCandidateAttempted(
  state: RuntimeInstallState,
  attemptedAt: string
): void {
  if (state.candidateReleaseId === undefined) {
    throw new Error("No Electron runtime candidate is awaiting validation");
  }
  state.candidateAttemptedAt = attemptedAt;
}

export function completeRuntimeCandidate(state: RuntimeInstallState): string {
  const candidate = state.candidateReleaseId;
  if (candidate === undefined) {
    throw new Error("No Electron runtime candidate is awaiting validation");
  }
  if (state.activeReleaseId === undefined) delete state.previousReleaseId;
  else state.previousReleaseId = state.activeReleaseId;
  state.activeReleaseId = candidate;
  delete state.candidateReleaseId;
  delete state.candidateAttemptedAt;
  state.badReleases = state.badReleases.filter(item => item.releaseId !== candidate);
  state.deferredReleases = state.deferredReleases.filter(item => item.releaseId !== candidate);
  delete state.lastError;
  return candidate;
}

export function rollbackRuntimeCandidate(
  state: RuntimeInstallState,
  failure: RuntimeLaunchFailureInput
): string {
  const candidate = state.candidateReleaseId;
  if (candidate === undefined) {
    throw new Error("No Electron runtime candidate is awaiting validation");
  }
  const record: RuntimeLaunchFailure = {
    releaseId: candidate,
    ...failure,
    retryable: true
  };
  delete state.candidateReleaseId;
  delete state.candidateAttemptedAt;
  state.deferredReleases = [
    ...state.deferredReleases.filter(item => item.releaseId !== candidate),
    record
  ].slice(-20);
  state.launchFailures = [...state.launchFailures, record].slice(-50);
  state.lastError = { message: failure.reason, occurredAt: failure.occurredAt };
  return candidate;
}

export function quarantineRuntimeRelease(
  state: RuntimeInstallState,
  releaseId: string,
  failure: Omit<BadRuntimeRelease, "releaseId">
): void {
  state.badReleases = [
    ...state.badReleases.filter(item => item.releaseId !== releaseId),
    { releaseId, ...failure }
  ].slice(-20);
  state.deferredReleases = state.deferredReleases.filter(item => item.releaseId !== releaseId);
  if (state.candidateReleaseId === releaseId) delete state.candidateReleaseId;
  if (state.candidateReleaseId === undefined) delete state.candidateAttemptedAt;
  if (state.activeReleaseId === releaseId) delete state.activeReleaseId;
  state.lastError = { message: failure.reason, occurredAt: failure.failedAt };
}

export function recordRuntimeLaunchFailure(
  state: RuntimeInstallState,
  releaseId: string,
  failure: RuntimeLaunchFailureInput
): void {
  const record: RuntimeLaunchFailure = {
    releaseId,
    ...failure,
    retryable: true
  };
  state.launchFailures = [...state.launchFailures, record].slice(-50);
  state.lastError = { message: failure.reason, occurredAt: failure.occurredAt };
}

export function parseRuntimeInstallState(
  value: unknown,
  expectedEnvironment: RuntimeEnvironment = "prod"
): RuntimeInstallState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Electron runtime state must be an object");
  }
  const state = value as Record<string, unknown>;
  if (state.schemaVersion === 1) {
    return migrateLegacyRuntimeInstallState(state, expectedEnvironment);
  }
  if (state.schemaVersion !== 2) {
    throw new Error("Electron runtime state schema is unsupported");
  }
  if (state.environment !== expectedEnvironment) {
    throw new Error(
      `Electron runtime state environment mismatch: expected ${expectedEnvironment}, received ${String(state.environment)}`
    );
  }
  validateReleaseIds(state, ["activeReleaseId", "previousReleaseId", "candidateReleaseId"]);
  if (
    state.candidateAttemptedAt !== undefined
    && (typeof state.candidateAttemptedAt !== "string" || state.candidateReleaseId === undefined)
  ) {
    throw new Error("Electron runtime state contains an invalid candidate attempt");
  }
  validateStateArrays(state);
  return state as unknown as RuntimeInstallState;
}

function migrateLegacyRuntimeInstallState(
  value: Record<string, unknown>,
  environment: RuntimeEnvironment
): RuntimeInstallState {
  validateReleaseIds(value, [
    "activeReleaseId",
    "previousReleaseId",
    "pendingReleaseId",
    "probationReleaseId"
  ]);
  if (!Array.isArray(value.badReleases)) {
    throw new Error("Electron runtime state schema is unsupported");
  }
  const legacy = value as unknown as LegacyRuntimeInstallState;
  const migrated = createEmptyRuntimeState(environment);
  if (legacy.probationReleaseId !== undefined) {
    if (legacy.previousReleaseId !== undefined) migrated.activeReleaseId = legacy.previousReleaseId;
    migrated.candidateReleaseId = legacy.probationReleaseId;
    migrated.candidateAttemptedAt = "1970-01-01T00:00:00.000Z";
  } else {
    if (legacy.activeReleaseId !== undefined) migrated.activeReleaseId = legacy.activeReleaseId;
    if (legacy.previousReleaseId !== undefined) migrated.previousReleaseId = legacy.previousReleaseId;
    if (legacy.pendingReleaseId !== undefined) migrated.candidateReleaseId = legacy.pendingReleaseId;
  }
  for (const item of legacy.badReleases) {
    validateReleaseRecord(item);
    const record: RuntimeLaunchFailure = {
      releaseId: item.releaseId,
      phase: "unknown",
      scope: "unknown",
      code: "LEGACY_UNCLASSIFIED",
      reason: item.reason,
      occurredAt: item.failedAt,
      retryable: true,
      legacyUnclassified: true
    };
    migrated.deferredReleases.push(record);
    migrated.launchFailures.push(record);
  }
  if (legacy.lastError !== undefined) migrated.lastError = legacy.lastError;
  return migrated;
}

function validateStateArrays(state: Record<string, unknown>): void {
  if (
    !Array.isArray(state.badReleases)
    || !Array.isArray(state.deferredReleases)
    || !Array.isArray(state.launchFailures)
  ) {
    throw new Error("Electron runtime state schema is unsupported");
  }
  for (const item of state.badReleases) validateReleaseRecord(item);
  for (const item of [...state.deferredReleases, ...state.launchFailures]) {
    validateReleaseRecord(item);
    if ((item as { retryable?: unknown }).retryable !== true) {
      throw new Error("Electron runtime state contains an invalid failure record");
    }
  }
}

function validateReleaseIds(
  state: Record<string, unknown>,
  keys: string[]
): void {
  for (const key of keys) {
    const releaseId = state[key];
    if (releaseId !== undefined && (
      typeof releaseId !== "string" || !isElectronRuntimeReleaseId(releaseId)
    )) {
      throw new Error("Electron runtime state contains an invalid release id");
    }
  }
}

function validateReleaseRecord(value: unknown): void {
  if (
    value === null
    || typeof value !== "object"
    || !isElectronRuntimeReleaseId((value as { releaseId?: unknown }).releaseId)
  ) {
    throw new Error("Electron runtime state contains an invalid release id");
  }
}
