import type { ArkmeProtocol } from "./app-identity.js";

export const ARKME_PROTOCOL = "arkme";

const SHARE_REF_PATTERN = /^extshare_[0-9a-f]{32}$/;

export type ArkmeExtensionShareAction = "author-chat" | "author-world";

export interface ArkmeExtensionShareDeepLink {
  kind: "extension-share";
  shareRef: string;
  action?: ArkmeExtensionShareAction;
}

export type ArkmeDeepLinkIntent = ArkmeExtensionShareDeepLink;

export type ArkmeProtocolClientRegistration =
  | { scheme: ArkmeProtocol }
  | { scheme: ArkmeProtocol; executable: string; args: string[] };

export function createProtocolClientRegistration(
  defaultApp: boolean,
  execPath: string,
  appEntryPath: string | undefined,
  protocol: ArkmeProtocol = ARKME_PROTOCOL
): ArkmeProtocolClientRegistration {
  return defaultApp && appEntryPath !== undefined
    ? { scheme: protocol, executable: execPath, args: [appEntryPath] }
    : { scheme: protocol };
}

export function parseArkmeDeepLink(
  raw: string,
  protocol: ArkmeProtocol = ARKME_PROTOCOL
): ArkmeDeepLinkIntent | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== `${protocol}:`
    || url.hostname !== "extensions"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || url.search !== ""
    || url.hash !== ""
  ) return undefined;
  const match = /^\/share\/([^/]+)(?:\/(author-chat|author-world))?$/.exec(url.pathname);
  const shareRef = match?.[1];
  if (shareRef === undefined || !SHARE_REF_PATTERN.test(shareRef)) return undefined;
  const action = match?.[2] as ArkmeExtensionShareAction | undefined;
  return action === undefined
    ? { kind: "extension-share", shareRef }
    : { kind: "extension-share", shareRef, action };
}

export function findArkmeDeepLink(
  argv: readonly string[],
  protocol: ArkmeProtocol = ARKME_PROTOCOL
): ArkmeDeepLinkIntent | undefined {
  for (const argument of argv) {
    const intent = parseArkmeDeepLink(argument, protocol);
    if (intent !== undefined) return intent;
  }
  return undefined;
}

export function createExtensionShareHarnessUrl(
  harnessUrl: string,
  intent: ArkmeExtensionShareDeepLink
): string {
  const base = new URL(harnessUrl);
  if (
    base.protocol !== "http:"
    || base.hostname !== "127.0.0.1"
    || base.username !== ""
    || base.password !== ""
    || base.port === ""
  ) throw new TypeError("Harness deep-link target must be a loopback HTTP origin");
  const actionSuffix = intent.action === undefined ? "" : `/${intent.action}`;
  return `${base.origin}/#/arkme/extensions/share/${intent.shareRef}${actionSuffix}`;
}

function sameIntent(left: ArkmeDeepLinkIntent, right: ArkmeDeepLinkIntent): boolean {
  return left.kind === right.kind
    && left.shareRef === right.shareRef
    && left.action === right.action;
}

export class ArkmeDeepLinkQueue {
  private pending: ArkmeDeepLinkIntent | undefined;

  push(intent: ArkmeDeepLinkIntent): void {
    this.pending = intent;
  }

  peek(): ArkmeDeepLinkIntent | undefined {
    return this.pending;
  }

  markDelivered(intent: ArkmeDeepLinkIntent): void {
    if (this.pending !== undefined && sameIntent(this.pending, intent)) {
      this.pending = undefined;
    }
  }
}
