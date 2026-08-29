import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  assertRuntimeFreePaths,
  assertRuntimeFreeResources,
  normalizeArchivePath,
  resolvePackagedSmokeEnvironment
} from "../scripts/packaged-smoke-lib.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("runtime-free packaged shell", () => {
  test("derives the smoke-test data root from the packaged service origin", () => {
    expect(resolvePackagedSmokeEnvironment(JSON.stringify({
      serviceBaseUrl: "https://api.jotmo.cc"
    }))).toEqual({ environment: "prod", userDataDirectoryName: "Arkme Harness" });
    expect(resolvePackagedSmokeEnvironment(JSON.stringify({
      serviceBaseUrl: "https://jotmo.senguo.me"
    }))).toEqual({ environment: "test", userDataDirectoryName: "Arkme Harness Test" });
    expect(() => resolvePackagedSmokeEnvironment(JSON.stringify({
      serviceBaseUrl: "https://evil.example"
    }))).toThrow(/not trusted/i);
  });

  test("normalizes Windows ASAR entries before checking required packaged files", () => {
    expect(normalizeArchivePath("\\dist\\main.js")).toBe("/dist/main.js");
  });

  test("accepts resources that contain only the unpacked preload", async () => {
    const resources = await mkdtemp(path.join(os.tmpdir(), "runtime-free-resources-"));
    temporaryDirectories.push(resources);
    await mkdir(path.join(resources, "dist"), { recursive: true });
    await writeFile(path.join(resources, "dist", "preload.cjs"), "preload");

    await expect(assertRuntimeFreeResources(resources)).resolves.toBeUndefined();
  });

  test("rejects a package that still embeds DSH or Arkme", async () => {
    const resources = await mkdtemp(path.join(os.tmpdir(), "runtime-bundled-resources-"));
    temporaryDirectories.push(resources);
    await mkdir(path.join(resources, "node_modules", "@deepseek-ai", "dsh"), { recursive: true });
    await writeFile(path.join(resources, "node_modules", "@deepseek-ai", "dsh", "package.json"), "{}");

    await expect(assertRuntimeFreeResources(resources)).rejects.toThrow(/bundled runtime/i);
  });

  test("rejects forbidden runtime paths listed inside app.asar", () => {
    expect(() => assertRuntimeFreePaths([
      "/dist/main.js",
      "/node_modules/@senguoyun/dsh-arkme/lib/index.js"
    ])).toThrow(/bundled runtime/i);
  });
});
