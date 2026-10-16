import type { RuntimeEnvironment } from "./runtime/service-config.js";

export type ArkmeProtocol = "arkme" | "arkme-test" | "arkme-local-test";

export interface ArkmeAppIdentity {
  appId: "com.senqisi.Jotmo" | "cc.jiwo.arkme" | "cc.jiwo.arkme.test" | "cc.jiwo.arkme.local-test";
  appName: "即我" | "arkme Test" | "arkme Local Test";
  protocol: ArkmeProtocol;
}

export function resolveArkmeAppIdentity(
  environment: RuntimeEnvironment,
  localTest = false,
  migrationTest = false,
  platform: NodeJS.Platform = process.platform
): ArkmeAppIdentity {
  if (localTest) {
    return {
      appId: "cc.jiwo.arkme.local-test",
      appName: "arkme Local Test",
      protocol: "arkme-local-test"
    };
  }
  return environment === "test" && !migrationTest
    ? {
      appId: "cc.jiwo.arkme.test",
      appName: "arkme Test",
      protocol: "arkme-test"
    }
    : {
      appId: platform === "darwin" ? "com.senqisi.Jotmo" : "cc.jiwo.arkme",
      appName: "即我",
      protocol: "arkme"
    };
}
