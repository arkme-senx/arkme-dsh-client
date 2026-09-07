import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  incompatibleShellNativeDependencyPaths,
  pruneIncompatibleShellNativeDependencies
} from "../scripts/prune-platform-app-dependencies.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("platform app dependencies", () => {
  it("keeps the macOS notification addon only on macOS", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-platform-app-deps-"));
    roots.push(root);
    const addon = path.join(root, "node_modules", "@arkme", "macos-notification-permission");
    await mkdir(addon, { recursive: true });

    expect(incompatibleShellNativeDependencyPaths(root, "darwin")).toEqual([]);
    expect(incompatibleShellNativeDependencyPaths(root, "win32")).toEqual([addon]);
    await pruneIncompatibleShellNativeDependencies(root, "win32");
    await expect(access(addon)).rejects.toThrow();
  });
});
