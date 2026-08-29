import type { RuntimeEnvironment } from "./runtime/service-config.js";

export type ArkmeProtocol = "arkme" | "arkme-test";

export interface ArkmeAppIdentity {
  appId: "cc.jiwo.arkme" | "cc.jiwo.arkme.test";
  appName: "arkme" | "arkme Test";
  protocol: ArkmeProtocol;
}

export function resolveArkmeAppIdentity(environment: RuntimeEnvironment): ArkmeAppIdentity {
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
