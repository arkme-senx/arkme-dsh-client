import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeUpdater {
    currentVersion: unknown;

    constructor(public readonly options: unknown) {}
  }

  class FakeMacUpdater extends FakeUpdater {}
  class FakeNsisUpdater extends FakeUpdater {}
  return { FakeUpdater, FakeMacUpdater, FakeNsisUpdater };
});

vi.mock("electron-updater", () => ({
  MacUpdater: mocks.FakeMacUpdater,
  NsisUpdater: mocks.FakeNsisUpdater
}));

describe("createElectronAppUpdater", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test.each([
    ["darwin", "0.2.6", "1.0.0", mocks.FakeMacUpdater],
    ["win32", "2.0.0", "0.0.0-0", mocks.FakeNsisUpdater]
  ] as const)("uses a string SemVer sentinel for %s", async (platform, targetVersion, sentinel, Updater) => {
    const { createElectronAppUpdater } = await import("../src/electron-app-updater.js");

    const result = createElectronAppUpdater(platform, "https://updates.example.test/", targetVersion) as unknown as InstanceType<typeof mocks.FakeUpdater>;

    expect(result).toBeInstanceOf(Updater);
    expect(result.currentVersion).toBe(sentinel);
    expect(typeof result.currentVersion).toBe("string");
  });
});
