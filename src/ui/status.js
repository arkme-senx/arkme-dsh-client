const params = new URLSearchParams(window.location.search);
const kind = params.get("kind") ?? "starting";
const environment = params.get("environment") === "test" ? "test" : "prod";
const isTestEnvironment = environment === "test";
const workspace = params.get("workspace") ?? "";
const message = params.get("message") ?? "";
const displayTitle = params.get("title") ?? "";
const suggestion = params.get("suggestion") ?? "";
const technicalDetails = params.get("technicalDetails") ?? "";
const showWorkspaceAction = params.get("showWorkspaceAction") !== "0";
const showReloadRuntimeAction = params.get("showReloadRuntimeAction") === "1";

const title = document.querySelector("#title");
const brandName = document.querySelector("#brand-name");
const environmentBadge = document.querySelector("#environment-badge");
const messageElement = document.querySelector("#message");
const workspaceElement = document.querySelector("#workspace");
const workspaceRow = document.querySelector("#workspace-row");
const spinner = document.querySelector("#spinner");
const failureIcon = document.querySelector("#failure-icon");
const actions = document.querySelector("#actions");
const runtimeProgress = document.querySelector("#runtime-progress");
const harnessProgress = document.querySelector("#harness-progress");
const pluginProgress = document.querySelector("#plugin-progress");
const harnessProgressLabel = document.querySelector("#harness-progress-label");
const pluginProgressLabel = document.querySelector("#plugin-progress-label");
const failureSuggestion = document.querySelector("#failure-suggestion");
const technicalDetailsElement = document.querySelector("#technical-details");
const chooseWorkspaceAction = document.querySelector("#choose-workspace-action");
const retryAction = document.querySelector("#retry-action");
const reloadRuntimeAction = document.querySelector("#reload-runtime-action");
const downloadStage = document.querySelector("#download-stage");
const verifyStage = document.querySelector("#verify-stage");
const installStage = document.querySelector("#install-stage");

document.body.dataset.environment = environment;
document.title = isTestEnvironment ? "arkme Test" : "arkme";
brandName.textContent = isTestEnvironment ? "arkme Test" : "arkme";
environmentBadge.textContent = "测试环境";
environmentBadge.hidden = !isTestEnvironment;

workspaceElement.textContent = workspace;
workspaceRow.hidden = workspace.length === 0;

if (kind === "runtime-installing") {
  renderRuntimeInstalling({
    kind: "runtime-installing",
    phase: params.get("phase") ?? "download",
    harnessPercent: boundedPercent(params.get("harnessPercent")),
    pluginPercent: boundedPercent(params.get("pluginPercent"))
  });
  window.arkmeRuntimeStatus?.onProgress(progress => {
    if (progress?.kind === "runtime-installing") renderRuntimeInstalling(progress);
  });
} else if (kind === "failed") {
  document.body.dataset.state = "failed";
  title.textContent = displayTitle || "DeepSeek Harness 启动失败";
  messageElement.textContent = message || "本地 Harness 服务未能启动";
  failureSuggestion.textContent = suggestion;
  failureSuggestion.hidden = suggestion.length === 0;
  technicalDetailsElement.textContent = technicalDetails.length === 0 ? "" : `技术信息：${technicalDetails}`;
  technicalDetailsElement.hidden = technicalDetails.length === 0;
  chooseWorkspaceAction.hidden = !showWorkspaceAction;
  retryAction.hidden = showReloadRuntimeAction;
  reloadRuntimeAction.hidden = !showReloadRuntimeAction;
  spinner.hidden = true;
  failureIcon.hidden = false;
  actions.hidden = false;
  runtimeProgress.hidden = true;
} else if (kind === "stopping") {
  title.textContent = "正在停止…";
  messageElement.textContent = "正在安全关闭本地 Harness 服务";
  spinner.hidden = false;
  failureIcon.hidden = true;
  actions.hidden = true;
  runtimeProgress.hidden = true;
} else {
  title.textContent = "正在启动…";
  messageElement.textContent = isTestEnvironment
    ? "正在准备测试环境运行服务"
    : "正在启动本地 Harness 服务";
  spinner.hidden = false;
  failureIcon.hidden = true;
  actions.hidden = true;
  runtimeProgress.hidden = true;
}

function renderRuntimeInstalling(progress) {
  const phase = ["download", "verify", "install"].includes(progress.phase)
    ? progress.phase
    : "download";
  const harnessPercent = boundedPercent(progress.harnessPercent);
  const pluginPercent = boundedPercent(progress.pluginPercent);
  title.textContent = "正在准备运行环境";
  messageElement.textContent = phase === "verify"
    ? "正在校验下载的运行环境"
    : phase === "install" ? "正在安装 Harness 和 Arkme 插件" : "首次启动需要下载运行环境";
  spinner.hidden = false;
  failureIcon.hidden = true;
  actions.hidden = true;
  runtimeProgress.hidden = false;
  setRuntimeStageStates(phase);
  harnessProgress.value = harnessPercent;
  pluginProgress.value = pluginPercent;
  harnessProgressLabel.textContent = `${harnessPercent}%`;
  pluginProgressLabel.textContent = pluginPercent === 0 ? "等待下载" : `${pluginPercent}%`;
}

function boundedPercent(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.floor(parsed))) : 0;
}

function setRuntimeStageStates(phase) {
  const order = ["download", "verify", "install"];
  const current = Math.max(0, order.indexOf(phase));
  for (const [index, element] of [downloadStage, verifyStage, installStage].entries()) {
    element.dataset.status = index < current ? "complete" : index === current ? "current" : "pending";
  }
}
