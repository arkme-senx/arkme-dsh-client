import { describe, expect, test } from "vitest";
import { decideNavigation } from "../src/navigation-policy.js";

const context = {
  statusPageUrl: "file:///Applications/arkme.app/Contents/Resources/app.asar/dist/ui/status.html",
  harnessOrigin: "http://127.0.0.1:41234"
};

describe("decideNavigation", () => {
  test("allows the local status page and active Harness origin", () => {
    expect(decideNavigation(`${context.statusPageUrl}?kind=starting`, context)).toEqual({
      kind: "allow"
    });
    expect(decideNavigation("http://127.0.0.1:41234/sessions/1", context)).toEqual({
      kind: "allow"
    });
  });

  test("maps only known app actions", () => {
    expect(decideNavigation("app-action://retry", context)).toEqual({
      kind: "action",
      action: "retry"
    });
    expect(decideNavigation("app-action://reload-runtime", context)).toEqual({
      kind: "action",
      action: "reload-runtime"
    });
    expect(decideNavigation("app-action://destroy-everything", context)).toEqual({
      kind: "deny"
    });
  });

  test("opens external HTTPS URLs outside Electron", () => {
    expect(decideNavigation("https://platform.deepseek.com/", context)).toEqual({
      kind: "external",
      url: "https://platform.deepseek.com/"
    });
  });

  test("denies other local ports, files, scripts and insecure external URLs", () => {
    for (const target of [
      "http://127.0.0.1:9999/",
      "http://example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)"
    ]) {
      expect(decideNavigation(target, context)).toEqual({ kind: "deny" });
    }
  });
});
