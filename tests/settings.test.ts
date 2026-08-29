import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  ensureDefaultWorkspace,
  loadLastWorkspace,
  resolveArkmeAppDataPath,
  resolveAppUpdateDownloadsPath,
  resolveUserDataPath,
  saveLastWorkspace
} from "../src/settings.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "jotmo-harness-settings-"));
}

describe("workspace settings", () => {
  test("creates a persistent default workspace under Arkme user data", async () => {
    const userDataPath = await makeTempDir();

    await expect(ensureDefaultWorkspace(userDataPath)).resolves.toBe(
      path.join(userDataPath, "workspace")
    );
    await expect(stat(path.join(userDataPath, "workspace"))).resolves.toMatchObject({
      isDirectory: expect.any(Function)
    });
  });

  test("uses an isolated Arkme application data directory", () => {
    const appDataPath = path.join(
      path.parse(process.cwd()).root,
      "Users",
      "example",
      "Library",
      "Application Support"
    );
    expect(resolveUserDataPath(appDataPath)).toBe(
      path.join(appDataPath, "Arkme Harness")
    );
    expect(resolveUserDataPath(appDataPath, "test")).toBe(
      path.join(appDataPath, "Arkme Harness Test")
    );
  });

  test("keeps production downloads unchanged and isolates test app updates", () => {
    expect(resolveAppUpdateDownloadsPath(
      "prod",
      "/Users/example/Library/Application Support/Arkme Harness",
      "/Users/example/Downloads"
    )).toBe("/Users/example/Downloads");
    expect(resolveAppUpdateDownloadsPath(
      "test",
      "/Users/example/Library/Application Support/Arkme Harness Test",
      "/Users/example/Downloads"
    )).toBe("/Users/example/Library/Application Support/Arkme Harness Test/app-updates");
  });

  test("uses an absolute development application-data override for an isolated client profile", () => {
    expect(resolveArkmeAppDataPath("/Users/example/Library/Application Support", "/tmp/arkme-v103-dev"))
      .toBe("/tmp/arkme-v103-dev");
    expect(resolveArkmeAppDataPath("/Users/example/Library/Application Support", undefined))
      .toBe("/Users/example/Library/Application Support");
    expect(() => resolveArkmeAppDataPath("/Users/example/Library/Application Support", "relative-profile"))
      .toThrow("must be an absolute path");
  });

  test("does not read or copy the retired Jotmo Harness user-data directory", async () => {
    const settingsSource = await readFile(new URL("../src/settings.ts", import.meta.url), "utf8");
    const mainSource = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");

    expect(settingsSource).not.toContain("Jotmo Harness");
    expect(settingsSource).not.toContain("migrateLegacyUserData");
    expect(mainSource).not.toContain("migrateLegacyUserData");
  });

  test("returns null when settings do not exist", async () => {
    const root = await makeTempDir();

    await expect(loadLastWorkspace(path.join(root, "settings.json"))).resolves.toBeNull();
  });

  test("persists and reloads an existing workspace directory", async () => {
    const root = await makeTempDir();
    const settingsPath = path.join(root, "config", "settings.json");
    const workspacePath = await mkdtemp(path.join(tmpdir(), "jotmo-workspace-"));

    await saveLastWorkspace(settingsPath, workspacePath);

    await expect(loadLastWorkspace(settingsPath)).resolves.toBe(workspacePath);
    const persisted = JSON.parse(await readFile(settingsPath, "utf8")) as {
      lastWorkspace?: string;
    };
    expect(persisted.lastWorkspace).toBe(workspacePath);
  });

  test("returns null for malformed settings", async () => {
    const root = await makeTempDir();
    const settingsPath = path.join(root, "settings.json");
    await writeFile(settingsPath, "not json", "utf8");

    await expect(loadLastWorkspace(settingsPath)).resolves.toBeNull();
  });

  test("returns null when the saved workspace no longer exists", async () => {
    const root = await makeTempDir();
    const settingsPath = path.join(root, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ lastWorkspace: path.join(root, "missing") }),
      "utf8"
    );

    await expect(loadLastWorkspace(settingsPath)).resolves.toBeNull();
  });
});
