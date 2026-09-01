import type { Session } from "electron";

export interface HarnessGeolocationPermissionInput {
  activeHarnessOrigin: string | null;
  embeddingOrigin: string | undefined;
  isMainFrame: boolean;
  mainWebContentsId: number | null;
  requestingOrigin: string | undefined;
  requestingUrl: string | undefined;
  requestingWebContentsId: number | null;
  requestingWebContentsUrl: string | undefined;
}

export interface HarnessPermissionDiagnostic {
  allowed: boolean;
  embeddingOrigin: string | null;
  isMainFrame: boolean;
  permission: "geolocation";
  phase: "check" | "request";
  requestingOrigin: string | null;
  webContentsMatches: boolean;
}

export interface HarnessPermissionPolicyContext {
  getActiveHarnessOrigin: () => string | null;
  getMainWebContentsId: () => number | null;
  diagnostic?: (details: HarnessPermissionDiagnostic) => void;
}

function parseLocalHarnessOrigin(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    if (
      url.protocol !== "http:"
      || url.hostname !== "127.0.0.1"
      || url.username.length > 0
      || url.password.length > 0
      || url.port.length === 0
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
    ) {
      return null;
    }
    return value === url.origin ? url.origin : null;
  } catch {
    return null;
  }
}

function parseRequestOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username.length > 0 || url.password.length > 0) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function diagnosticRequestOrigin(
  requestingUrl: string | undefined,
  requestingOrigin: string | undefined
): string | null {
  for (const value of [requestingUrl, requestingOrigin]) {
    if (value === undefined) continue;
    const origin = parseRequestOrigin(value);
    if (origin !== null) return origin;
  }
  return null;
}

export function shouldAllowHarnessGeolocation(input: HarnessGeolocationPermissionInput): boolean {
  const activeHarnessOrigin = parseLocalHarnessOrigin(input.activeHarnessOrigin);
  if (activeHarnessOrigin === null) return false;
  if (
    input.mainWebContentsId === null
    || input.requestingWebContentsId === null
    || input.requestingWebContentsId !== input.mainWebContentsId
  ) {
    return false;
  }

  if (
    input.requestingWebContentsUrl === undefined
    || parseRequestOrigin(input.requestingWebContentsUrl) !== activeHarnessOrigin
  ) {
    return false;
  }

  const requestSources = [input.requestingOrigin, input.requestingUrl, input.embeddingOrigin]
    .filter((value): value is string => value !== undefined);
  if (requestSources.length === 0) return false;
  return requestSources.every(value => parseRequestOrigin(value) === activeHarnessOrigin);
}

function emitDiagnostic(
  context: HarnessPermissionPolicyContext,
  details: HarnessPermissionDiagnostic
): void {
  try {
    context.diagnostic?.(details);
  } catch {
    // Permission decisions must not depend on diagnostics being writable.
  }
}

export function installHarnessPermissionPolicy(
  permissionSession: Session,
  context: HarnessPermissionPolicyContext
): void {
  permissionSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission !== "geolocation") return permission !== "deprecated-sync-clipboard-read";

    const mainWebContentsId = context.getMainWebContentsId();
    const requestingWebContentsId = webContents?.id ?? null;
    const input: HarnessGeolocationPermissionInput = {
      activeHarnessOrigin: context.getActiveHarnessOrigin(),
      embeddingOrigin: details.embeddingOrigin,
      isMainFrame: details.isMainFrame,
      mainWebContentsId,
      requestingOrigin,
      requestingUrl: details.requestingUrl,
      requestingWebContentsId,
      requestingWebContentsUrl: webContents === null || webContents.isDestroyed()
        ? undefined
        : webContents.getURL()
    };
    const allowed = shouldAllowHarnessGeolocation(input);
    emitDiagnostic(context, {
      allowed,
      embeddingOrigin: diagnosticRequestOrigin(details.embeddingOrigin, undefined),
      isMainFrame: details.isMainFrame,
      permission,
      phase: "check",
      requestingOrigin: diagnosticRequestOrigin(details.requestingUrl, requestingOrigin),
      webContentsMatches: mainWebContentsId !== null && requestingWebContentsId === mainWebContentsId
    });
    return allowed;
  });

  permissionSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== "geolocation") {
      callback(true);
      return;
    }

    const mainWebContentsId = context.getMainWebContentsId();
    const requestingWebContentsId = webContents.id;
    const input: HarnessGeolocationPermissionInput = {
      activeHarnessOrigin: context.getActiveHarnessOrigin(),
      embeddingOrigin: undefined,
      isMainFrame: details.isMainFrame,
      mainWebContentsId,
      requestingOrigin: undefined,
      requestingUrl: details.requestingUrl,
      requestingWebContentsId,
      requestingWebContentsUrl: webContents.isDestroyed() ? undefined : webContents.getURL()
    };
    const allowed = shouldAllowHarnessGeolocation(input);
    emitDiagnostic(context, {
      allowed,
      embeddingOrigin: null,
      isMainFrame: details.isMainFrame,
      permission,
      phase: "request",
      requestingOrigin: diagnosticRequestOrigin(details.requestingUrl, undefined),
      webContentsMatches: mainWebContentsId !== null && requestingWebContentsId === mainWebContentsId
    });
    callback(allowed);
  });
}
