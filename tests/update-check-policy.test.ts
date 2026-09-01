import { describe, expect, test } from "vitest";
import {
  isAutomaticUpdateCheckEnabled,
  withStartupUpdateCheckEnvironment
} from "../src/update-check-policy.js";

describe("automatic update check environment", () => {
  test("defaults automatic checks to enabled and disables them only for the exact zero value", () => {
    expect(isAutomaticUpdateCheckEnabled({})).toBe(true);
    expect(isAutomaticUpdateCheckEnabled({ ARKME_UPDATE_CHECK_ENABLED: "1" })).toBe(true);
    expect(isAutomaticUpdateCheckEnabled({ ARKME_UPDATE_CHECK_ENABLED: "false" })).toBe(true);
    expect(isAutomaticUpdateCheckEnabled({ ARKME_UPDATE_CHECK_ENABLED: "0" })).toBe(false);
  });

  test("injects a fixed development policy without mutating the inherited environment", () => {
    const inherited = { ARKME_UPDATE_CHECK_ENABLED: "external", KEEP_ME: "yes" };

    expect(withStartupUpdateCheckEnvironment(inherited, false, false)).toEqual({
      ARKME_UPDATE_CHECK_ENABLED: "0",
      KEEP_ME: "yes"
    });
    expect(withStartupUpdateCheckEnvironment(inherited, true, true)).toEqual({
      ARKME_UPDATE_CHECK_ENABLED: "0",
      KEEP_ME: "yes"
    });
    expect(withStartupUpdateCheckEnvironment(inherited, true, false)).toEqual({
      ARKME_UPDATE_CHECK_ENABLED: "1",
      KEEP_ME: "yes"
    });
    expect(inherited.ARKME_UPDATE_CHECK_ENABLED).toBe("external");
  });
});
