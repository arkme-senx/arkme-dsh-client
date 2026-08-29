import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  PRODUCTION_RUNTIME_SERVICE_ORIGIN,
  TEST_RUNTIME_SERVICE_ORIGIN,
  readPackagedRuntimeServiceConfig,
  readPackagedRuntimeServiceOrigin,
  resolveRuntimeEnvironment,
  resolveRuntimeServiceOrigin
} from "../src/runtime/service-config.js";

describe("Electron runtime service configuration", () => {
  test("defaults production builds to the production service", () => {
    expect(resolveRuntimeServiceOrigin(undefined)).toBe(PRODUCTION_RUNTIME_SERVICE_ORIGIN);
    expect(resolveRuntimeServiceOrigin("")).toBe(PRODUCTION_RUNTIME_SERVICE_ORIGIN);
  });

  test("accepts only the exact production and test service origins", () => {
    expect(resolveRuntimeServiceOrigin("https://api.jotmo.cc")).toBe(PRODUCTION_RUNTIME_SERVICE_ORIGIN);
    expect(resolveRuntimeServiceOrigin("https://jotmo.senguo.me")).toBe(TEST_RUNTIME_SERVICE_ORIGIN);
    expect(() => resolveRuntimeServiceOrigin("https://evil.example")).toThrow(/not trusted/i);
    expect(() => resolveRuntimeServiceOrigin("https://jotmo.senguo.me/path")).toThrow(/not trusted/i);
  });

  test("derives one runtime environment from each trusted service origin", () => {
    expect(resolveRuntimeEnvironment(PRODUCTION_RUNTIME_SERVICE_ORIGIN)).toBe("prod");
    expect(resolveRuntimeEnvironment(TEST_RUNTIME_SERVICE_ORIGIN)).toBe("test");
    expect(() => resolveRuntimeEnvironment("https://evil.example")).toThrow(/not trusted/i);
  });

  test("reads the service origin baked into a packaged build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-runtime-service-config-"));
    await writeFile(
      path.join(root, "runtime-service-config.json"),
      `${JSON.stringify({ environment: "test", serviceBaseUrl: TEST_RUNTIME_SERVICE_ORIGIN })}\n`
    );

    await expect(readPackagedRuntimeServiceOrigin(root)).resolves.toBe(TEST_RUNTIME_SERVICE_ORIGIN);
    expect(readPackagedRuntimeServiceConfig(root)).toEqual({
      environment: "test",
      serviceBaseUrl: TEST_RUNTIME_SERVICE_ORIGIN
    });
  });

  test("rejects a packaged environment marker that disagrees with its trusted service", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkme-runtime-service-config-mismatch-"));
    await writeFile(
      path.join(root, "runtime-service-config.json"),
      `${JSON.stringify({ environment: "prod", serviceBaseUrl: TEST_RUNTIME_SERVICE_ORIGIN })}\n`
    );

    expect(() => readPackagedRuntimeServiceConfig(root)).toThrow(/environment.*mismatch/i);
    await expect(readPackagedRuntimeServiceOrigin(root)).rejects.toThrow(/environment.*mismatch/i);
  });
});
