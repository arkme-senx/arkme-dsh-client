import { pathToFileURL } from "node:url";
import { createStatusPageUrl } from "../status-url.js";
import type { RuntimeInstallProgress } from "./manager.js";
import type { RuntimeEnvironment } from "./service-config.js";

export const RUNTIME_STATUS_PROGRESS_CHANNEL = "arkme:runtime-status:progress";

export interface CoalescedAsyncRenderer<T> {
  schedule(value: T): void;
  flush(): Promise<void>;
}

export interface RuntimeProgressPageTarget {
  getCurrentUrl(): string;
  loadUrl(url: string): Promise<void>;
  sendProgress(progress: RuntimeInstallProgress): void;
}

export function createRuntimeProgressPageRenderer(
  target: RuntimeProgressPageTarget,
  statusHtmlPath: string,
  environment: RuntimeEnvironment = "prod"
): (progress: RuntimeInstallProgress) => Promise<"loaded" | "updated"> {
  const expectedStatusUrl = pathToFileURL(statusHtmlPath);
  return async progress => {
    if (isRuntimeProgressPage(target.getCurrentUrl(), expectedStatusUrl)) {
      target.sendProgress(progress);
      return "updated";
    }
    await target.loadUrl(createStatusPageUrl(statusHtmlPath, progress, environment));
    return "loaded";
  };
}

function isRuntimeProgressPage(currentUrl: string, expectedStatusUrl: URL): boolean {
  try {
    const current = new URL(currentUrl);
    return current.protocol === expectedStatusUrl.protocol
      && current.host === expectedStatusUrl.host
      && current.pathname === expectedStatusUrl.pathname
      && current.searchParams.get("kind") === "runtime-installing";
  } catch {
    return false;
  }
}

export function createCoalescedAsyncRenderer<T>(
  render: (value: T) => Promise<void>,
  delayMs: number
): CoalescedAsyncRenderer<T> {
  let pending: T | undefined;
  let hasPending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();

  const enqueueLatest = () => {
    if (!hasPending) return;
    const value = pending as T;
    pending = undefined;
    hasPending = false;
    queue = queue.then(() => render(value));
  };

  return {
    schedule(value) {
      pending = value;
      hasPending = true;
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        enqueueLatest();
      }, delayMs);
    },
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      enqueueLatest();
      await queue;
    }
  };
}
