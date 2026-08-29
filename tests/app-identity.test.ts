import { describe, expect, test } from "vitest";
import { resolveArkmeAppIdentity } from "../src/app-identity.js";

describe("Arkme application identity", () => {
  test("uses the public production application identity", () => {
    expect(resolveArkmeAppIdentity("prod")).toEqual({
      appId: "cc.jiwo.arkme",
      appName: "arkme",
      protocol: "arkme"
    });
  });

  test("uses a side-by-side identity for the test application", () => {
    expect(resolveArkmeAppIdentity("test")).toEqual({
      appId: "cc.jiwo.arkme.test",
      appName: "arkme Test",
      protocol: "arkme-test"
    });
  });
});
