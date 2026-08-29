export type AppAction = "retry" | "reload-runtime" | "choose-workspace" | "open-logs";

export type NavigationDecision =
  | { kind: "allow" }
  | { kind: "action"; action: AppAction }
  | { kind: "external"; url: string }
  | { kind: "deny" };

interface NavigationContext {
  statusPageUrl: string;
  harnessOrigin: string | null;
}

const APP_ACTIONS = new Set<AppAction>(["retry", "reload-runtime", "choose-workspace", "open-logs"]);

export function decideNavigation(
  targetUrl: string,
  context: NavigationContext
): NavigationDecision {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return { kind: "deny" };
  }

  if (target.protocol === "app-action:") {
    const action = target.hostname as AppAction;
    return APP_ACTIONS.has(action) ? { kind: "action", action } : { kind: "deny" };
  }

  const statusPage = new URL(context.statusPageUrl);
  if (target.protocol === "file:" && target.pathname === statusPage.pathname) {
    return { kind: "allow" };
  }

  if (context.harnessOrigin !== null && target.origin === context.harnessOrigin) {
    return { kind: "allow" };
  }

  if (target.protocol === "https:") {
    return { kind: "external", url: target.href };
  }

  return { kind: "deny" };
}
