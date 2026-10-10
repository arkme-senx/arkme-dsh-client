import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { readPackagedRuntimeServiceConfig } from "../src/runtime/service-config.js";
import { resolveArkmeAppIdentity } from "../src/app-identity.js";
import { resolvePackagedExecutableName } from "../scripts/packaged-smoke-lib.mjs";

test("migration test packages keep release identity while retaining test service isolation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jiwo-migration-test-"));
  await writeFile(path.join(root, "runtime-service-config.json"), JSON.stringify({
    environment: "test", serviceBaseUrl: "https://jotmo.senguo.me", migrationTest: true
  }));
  const config = readPackagedRuntimeServiceConfig(root);
  expect(config.migrationTest).toBe(true);
  expect(config.environment).toBe("test");
  expect(resolveArkmeAppIdentity(config.environment, false, config.migrationTest).appId).toBe("cc.jiwo.arkme");
  expect(resolvePackagedExecutableName("test", true)).toBe("arkme");
  expect(resolveArkmeAppIdentity("test").appId).toBe("cc.jiwo.arkme.test");
});

test.each([true, "true"])("rejects migration-test markers on the production service: %s", async migrationTest => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jiwo-migration-test-"));
  await writeFile(path.join(root, "runtime-service-config.json"), JSON.stringify({
    environment: "prod", serviceBaseUrl: "https://api.jotmo.cc", migrationTest
  }));
  expect(() => readPackagedRuntimeServiceConfig(root)).toThrow(/migration/i);
});
