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

  test("opens HTTP and HTTPS URLs, including other localhost ports, outside Electron", () => {
    for (const url of [
      "https://platform.deepseek.com/", "http://www.google.com/", "http://example.com/path?q=1#section",
      "http://127.example.com/", "http://127.0.0.1:9999/", "http://localhost:9999/", "http://[::1]:9999/",
    ]) {
      expect(decideNavigation(url, context)).toEqual({ kind: "external", url });
    }
  });

  test("denies files, scripts and unsupported protocols", () => {
    for (const target of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hello",
      "mailto:example@example.com",
      "not a URL"
    ]) {
      expect(decideNavigation(target, context)).toEqual({ kind: "deny" });
    }
  });
});
