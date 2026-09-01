import type { Session, WebContents } from "electron";
import { describe, expect, test, vi } from "vitest";
import {
  installHarnessPermissionPolicy,
  shouldAllowHarnessGeolocation,
  type HarnessGeolocationPermissionInput
} from "../src/harness-permission-policy.js";

const harnessOrigin = "http://127.0.0.1:41234";

function validInput(
  overrides: Partial<HarnessGeolocationPermissionInput> = {}
): HarnessGeolocationPermissionInput {
  return {
    activeHarnessOrigin: harnessOrigin,
    embeddingOrigin: undefined,
    isMainFrame: true,
    mainWebContentsId: 7,
    requestingOrigin: harnessOrigin,
    requestingUrl: `${harnessOrigin}/chat/private/1`,
    requestingWebContentsId: 7,
    requestingWebContentsUrl: `${harnessOrigin}/chat/private/1`,
    ...overrides
  };
}

describe("shouldAllowHarnessGeolocation", () => {
  test("allows the current Harness frame in the current main window", () => {
    expect(shouldAllowHarnessGeolocation(validInput())).toBe(true);
    expect(shouldAllowHarnessGeolocation(validInput({
      embeddingOrigin: harnessOrigin,
      isMainFrame: false
    }))).toBe(true);
  });

  test("requires an explicit HTTP IPv4 loopback port for the active Harness", () => {
    for (const activeHarnessOrigin of [
      null,
      "http://127.0.0.1",
      "http://127.0.0.1:0",
      "http://127.0.0.1:41234/path",
      "http://127.1:41234",
      "http://localhost:41234",
      "http://[::1]:41234",
      "https://127.0.0.1:41234",
      "http://user@127.0.0.1:41234",
      "not a URL"
    ]) {
      expect(shouldAllowHarnessGeolocation(validInput({ activeHarnessOrigin }))).toBe(false);
    }
  });

  test("denies external origins, other Harness ports and stale window URLs", () => {
    expect(shouldAllowHarnessGeolocation(validInput({
      requestingOrigin: "https://example.com",
      requestingUrl: "https://example.com/page"
    }))).toBe(false);
    expect(shouldAllowHarnessGeolocation(validInput({
      requestingOrigin: "http://127.0.0.1:49999",
      requestingUrl: "http://127.0.0.1:49999/chat"
    }))).toBe(false);
    expect(shouldAllowHarnessGeolocation(validInput({
      requestingWebContentsUrl: "file:///Applications/arkme.app/status.html"
    }))).toBe(false);
    expect(shouldAllowHarnessGeolocation(validInput({
      requestingUrl: "http://user@127.0.0.1:41234/chat"
    }))).toBe(false);
  });

  test("denies cross-origin subframes, other webContents and incomplete request context", () => {
    expect(shouldAllowHarnessGeolocation(validInput({
      embeddingOrigin: "https://example.com",
      isMainFrame: false
    }))).toBe(false);
    expect(shouldAllowHarnessGeolocation(validInput({
      embeddingOrigin: harnessOrigin,
      isMainFrame: false,
      requestingOrigin: "https://example.com",
      requestingUrl: undefined
    }))).toBe(false);
    expect(shouldAllowHarnessGeolocation(validInput({ requestingWebContentsId: 8 }))).toBe(false);
    expect(shouldAllowHarnessGeolocation(validInput({ mainWebContentsId: null }))).toBe(false);
    expect(shouldAllowHarnessGeolocation(validInput({ requestingWebContentsId: null }))).toBe(false);
    expect(shouldAllowHarnessGeolocation(validInput({
      requestingOrigin: undefined,
      requestingUrl: undefined
    }))).toBe(false);
    expect(shouldAllowHarnessGeolocation(validInput({
      requestingWebContentsUrl: undefined
    }))).toBe(false);
  });
});

type CheckHandler = Exclude<Parameters<Session["setPermissionCheckHandler"]>[0], null>;
type RequestHandler = Exclude<Parameters<Session["setPermissionRequestHandler"]>[0], null>;

function installedPolicy(options: {
  activeHarnessOrigin?: string | null;
  currentUrl?: string;
  diagnostic?: Parameters<typeof installHarnessPermissionPolicy>[1]["diagnostic"];
} = {}): {
  check: CheckHandler;
  request: RequestHandler;
  webContents: WebContents;
} {
  let check: CheckHandler | undefined;
  let request: RequestHandler | undefined;
  const permissionSession = {
    setPermissionCheckHandler(handler: CheckHandler | null) {
      check = handler ?? undefined;
    },
    setPermissionRequestHandler(handler: RequestHandler | null) {
      request = handler ?? undefined;
    }
  } as unknown as Session;
  const webContents = {
    getURL: () => options.currentUrl ?? `${harnessOrigin}/chat/private/1`,
    id: 7,
    isDestroyed: () => false
  } as unknown as WebContents;
  installHarnessPermissionPolicy(permissionSession, {
    getActiveHarnessOrigin: () => options.activeHarnessOrigin === undefined
      ? harnessOrigin
      : options.activeHarnessOrigin,
    getMainWebContentsId: () => 7,
    ...(options.diagnostic === undefined ? {} : { diagnostic: options.diagnostic })
  });
  if (check === undefined || request === undefined) {
    throw new Error("permission handlers were not installed");
  }
  return { check, request, webContents };
}

describe("installHarnessPermissionPolicy", () => {
  test("installs both Electron 43 handlers and grants scoped geolocation", () => {
    const diagnostic = vi.fn();
    const { check, request, webContents } = installedPolicy({ diagnostic });

    expect(check(webContents, "geolocation", harnessOrigin, {
      isMainFrame: true,
      requestingUrl: `${harnessOrigin}/chat/private/1`
    })).toBe(true);
    const callback = vi.fn();
    request(webContents, "geolocation", callback, {
      isMainFrame: true,
      requestingUrl: `${harnessOrigin}/chat/private/1`
    });
    expect(callback).toHaveBeenCalledWith(true);
    expect(diagnostic).toHaveBeenNthCalledWith(1, {
      allowed: true,
      embeddingOrigin: null,
      isMainFrame: true,
      permission: "geolocation",
      phase: "check",
      requestingOrigin: harnessOrigin,
      webContentsMatches: true
    });
    expect(diagnostic).toHaveBeenNthCalledWith(2, {
      allowed: true,
      embeddingOrigin: null,
      isMainFrame: true,
      permission: "geolocation",
      phase: "request",
      requestingOrigin: harnessOrigin,
      webContentsMatches: true
    });
  });

  test("allows a same-origin subframe but denies a cross-origin subframe or another webContents", () => {
    const { check, request, webContents } = installedPolicy();
    expect(check(webContents, "geolocation", harnessOrigin, {
      isMainFrame: false,
      requestingUrl: `${harnessOrigin}/embedded`
    })).toBe(true);
    expect(check(webContents, "geolocation", harnessOrigin, {
      embeddingOrigin: harnessOrigin,
      isMainFrame: false,
      requestingUrl: `${harnessOrigin}/embedded`
    })).toBe(true);
    expect(check(webContents, "geolocation", "https://example.com", {
      embeddingOrigin: harnessOrigin,
      isMainFrame: false
    })).toBe(false);
    expect(check(webContents, "geolocation", harnessOrigin, {
      embeddingOrigin: "https://example.com",
      isMainFrame: false
    })).toBe(false);
    expect(check(null, "geolocation", harnessOrigin, {
      isMainFrame: false,
      requestingUrl: `${harnessOrigin}/embedded`
    })).toBe(false);

    const sameOriginCallback = vi.fn();
    request(webContents, "geolocation", sameOriginCallback, {
      isMainFrame: false,
      requestingUrl: `${harnessOrigin}/embedded`
    });
    expect(sameOriginCallback).toHaveBeenCalledWith(true);

    const otherWebContents = {
      getURL: () => `${harnessOrigin}/chat/private/1`,
      id: 8,
      isDestroyed: () => false
    } as unknown as WebContents;
    const callback = vi.fn();
    request(otherWebContents, "geolocation", callback, {
      isMainFrame: true,
      requestingUrl: `${harnessOrigin}/chat/private/1`
    });
    expect(callback).toHaveBeenCalledWith(false);
  });

  test("preserves the previous default-grant behavior for non-geolocation permissions", () => {
    const diagnostic = vi.fn();
    const { check, request, webContents } = installedPolicy({ diagnostic });

    expect(check(webContents, "media", "https://example.com", {
      isMainFrame: false,
      mediaType: "video",
      requestingUrl: "https://example.com/camera"
    })).toBe(true);
    const callback = vi.fn();
    request(webContents, "media", callback, {
      isMainFrame: false,
      mediaTypes: ["audio", "video"],
      requestingUrl: "https://example.com/camera",
      securityOrigin: "https://example.com"
    });
    expect(callback).toHaveBeenCalledWith(true);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  test("preserves Electron's denied deprecated synchronous clipboard check", () => {
    const diagnostic = vi.fn();
    const { check, webContents } = installedPolicy({ diagnostic });

    expect(check(webContents, "deprecated-sync-clipboard-read", harnessOrigin, {
      isMainFrame: true,
      requestingUrl: `${harnessOrigin}/chat/private/1`
    })).toBe(false);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  test("fails geolocation closed when the current window is no longer on Harness", () => {
    const { request, webContents } = installedPolicy({
      currentUrl: "file:///Applications/arkme.app/status.html"
    });
    const callback = vi.fn();
    request(webContents, "geolocation", callback, {
      isMainFrame: true,
      requestingUrl: `${harnessOrigin}/chat/private/1`
    });
    expect(callback).toHaveBeenCalledWith(false);
  });

  test("does not let diagnostic failures change the permission result", () => {
    const { check, webContents } = installedPolicy({
      diagnostic: () => { throw new Error("disk unavailable"); }
    });
    expect(check(webContents, "geolocation", harnessOrigin, {
      isMainFrame: true,
      requestingUrl: `${harnessOrigin}/chat/private/1`
    })).toBe(true);
  });
});
