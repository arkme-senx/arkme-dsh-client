import { pathToFileURL } from "node:url";
import type { HarnessState } from "./harness-supervisor.js";
import type { RuntimeEnvironment } from "./runtime/service-config.js";
import type { RuntimeInstallProgress } from "./runtime/manager.js";

type StatusPageState = Exclude<HarnessState, { kind: "ready" }> | RuntimeInstallProgress;

export function createStatusPageUrl(
  statusHtmlPath: string,
  state: StatusPageState,
  environment: RuntimeEnvironment = "prod"
): string {
  const url = pathToFileURL(statusHtmlPath);
  url.searchParams.set("kind", state.kind);
  url.searchParams.set("environment", environment);
  if (state.kind === "runtime-installing") {
    url.searchParams.set("phase", state.phase);
    url.searchParams.set("harnessPercent", String(clampPercent(state.harnessPercent)));
    url.searchParams.set("pluginPercent", String(clampPercent(state.pluginPercent)));
  }
  if ("workspacePath" in state && state.workspacePath !== undefined) {
    url.searchParams.set("workspace", state.workspacePath);
  }
  if (state.kind === "failed") {
    url.searchParams.set("message", state.message);
    if (state.displayTitle !== undefined) url.searchParams.set("title", state.displayTitle);
    if (state.suggestion !== undefined) url.searchParams.set("suggestion", state.suggestion);
    if (state.technicalDetails !== undefined) url.searchParams.set("technicalDetails", state.technicalDetails);
    if (state.showWorkspaceAction === false) url.searchParams.set("showWorkspaceAction", "0");
    if (state.showReloadRuntimeAction === true) url.searchParams.set("showReloadRuntimeAction", "1");
  }
  return url.href;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.floor(Number.isFinite(value) ? value : 0)));
}
