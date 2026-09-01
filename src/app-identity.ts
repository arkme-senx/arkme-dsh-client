import type { RuntimeEnvironment } from "./runtime/service-config.js";

export type ArkmeProtocol = "arkme" | "arkme-test" | "arkme-local-test";

export interface ArkmeAppIdentity {
  appId: "cc.jiwo.arkme" | "cc.jiwo.arkme.test" | "cc.jiwo.arkme.local-test";
  appName: "arkme" | "arkme Test" | "arkme Local Test";
  protocol: ArkmeProtocol;
}

export function resolveArkmeAppIdentity(
  environment: RuntimeEnvironment,
  localTest = false
): ArkmeAppIdentity {
  if (localTest) {
    return {
      appId: "cc.jiwo.arkme.local-test",
      appName: "arkme Local Test",
      protocol: "arkme-local-test"
    };
  }
  return environment === "test"
    ? {
      appId: "cc.jiwo.arkme.test",
      appName: "arkme Test",
      protocol: "arkme-test"
    }
    : {
      appId: "cc.jiwo.arkme",
      appName: "arkme",
      protocol: "arkme"
    };
}
