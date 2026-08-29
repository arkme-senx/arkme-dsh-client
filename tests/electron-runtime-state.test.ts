import { describe, expect, test } from "vitest";
import {
  beginRuntimeCandidate,
  completeRuntimeCandidate,
  createEmptyRuntimeState,
  parseRuntimeInstallState,
  quarantineRuntimeRelease,
  rollbackRuntimeCandidate
} from "../src/runtime/state.js";

describe("Electron runtime activation state", () => {
  test("keeps the last verified release active while a candidate is in probation", () => {
    const state = createEmptyRuntimeState("prod");
    state.activeReleaseId = "release-1";

    beginRuntimeCandidate(state, "release-2");

    expect(state).toMatchObject({
      schemaVersion: 2,
      environment: "prod",
      activeReleaseId: "release-1",
      candidateReleaseId: "release-2"
    });
  });

  test("commits a healthy candidate and retains the last verified release", () => {
    const state = createEmptyRuntimeState("prod");
    state.activeReleaseId = "release-1";
    beginRuntimeCandidate(state, "release-2");

    expect(completeRuntimeCandidate(state)).toBe("release-2");

    expect(state.activeReleaseId).toBe("release-2");
    expect(state.previousReleaseId).toBe("release-1");
    expect(state.candidateReleaseId).toBeUndefined();
  });

  test("rolls back an ordinary startup failure without marking the candidate bad", () => {
    const state = createEmptyRuntimeState("test");
    state.activeReleaseId = "release-1";
    beginRuntimeCandidate(state, "release-2");

    expect(rollbackRuntimeCandidate(state, {
      phase: "workspace-registration",
      scope: "workspace",
      code: "WORKSPACE_REGISTRATION_TIMEOUT",
      reason: "workspace registration timed out",
      occurredAt: "2026-08-27T00:00:00Z"
    })).toBe("release-2");

    expect(state.activeReleaseId).toBe("release-1");
    expect(state.candidateReleaseId).toBeUndefined();
    expect(state.badReleases).toEqual([]);
    expect(state.deferredReleases).toEqual([expect.objectContaining({
      releaseId: "release-2",
      scope: "workspace",
      retryable: true
    })]);
    expect(state.launchFailures).toHaveLength(1);
  });

  test("marks a release bad only through explicit quarantine with artifact evidence", () => {
    const state = createEmptyRuntimeState("prod");
    beginRuntimeCandidate(state, "release-2");

    quarantineRuntimeRelease(state, "release-2", {
      code: "RELEASE_IDENTITY_MISMATCH",
      reason: "stored release identity does not match its directory",
      failedAt: "2026-08-27T00:00:00Z"
    });

    expect(state.candidateReleaseId).toBeUndefined();
    expect(state.badReleases).toEqual([{
      releaseId: "release-2",
      code: "RELEASE_IDENTITY_MISMATCH",
      reason: "stored release identity does not match its directory",
      failedAt: "2026-08-27T00:00:00Z"
    }]);
  });

  test("migrates broad schema v1 bad entries into environment-scoped retryable failures", () => {
    const state = parseRuntimeInstallState({
      schemaVersion: 1,
      activeReleaseId: "electron-runtime-v1-11111111111111111111111111111111",
      previousReleaseId: "electron-runtime-v1-22222222222222222222222222222222",
      probationReleaseId: "electron-runtime-v1-11111111111111111111111111111111",
      badReleases: [{
        releaseId: "electron-runtime-v1-33333333333333333333333333333333",
        reason: "an unrelated startup error",
        failedAt: "2026-08-27T00:00:00Z"
      }]
    }, "test");

    expect(state).toMatchObject({
      schemaVersion: 2,
      environment: "test",
      activeReleaseId: "electron-runtime-v1-22222222222222222222222222222222",
      candidateReleaseId: "electron-runtime-v1-11111111111111111111111111111111",
      badReleases: []
    });
    expect(state.deferredReleases).toEqual([expect.objectContaining({
      releaseId: "electron-runtime-v1-33333333333333333333333333333333",
      scope: "unknown",
      code: "LEGACY_UNCLASSIFIED",
      legacyUnclassified: true,
      retryable: true
    })]);
  });

  test("rejects a schema v2 state belonging to another environment", () => {
    expect(() => parseRuntimeInstallState({
      schemaVersion: 2,
      environment: "prod",
      badReleases: [],
      deferredReleases: [],
      launchFailures: []
    }, "test")).toThrow(/environment mismatch/i);
  });

  test.each([".", "..", "release-1", "electron-runtime-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"])(
    "rejects unsafe persisted release id %s before path construction",
    releaseId => {
      expect(() => parseRuntimeInstallState({
        schemaVersion: 2,
        environment: "prod",
        activeReleaseId: releaseId,
        badReleases: [],
        deferredReleases: [],
        launchFailures: []
      }, "prod")).toThrow(/invalid release id/i);
    }
  );
});
