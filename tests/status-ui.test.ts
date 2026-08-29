import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, test } from "vitest";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface FakeElement {
  dataset: Record<string, string>;
  hidden: boolean;
  textContent: string;
  value: number;
}

interface RenderedStatus {
  elements: Map<string, FakeElement>;
  emitRuntimeProgress(progress: {
    kind: "runtime-installing";
    phase: "download" | "verify" | "install";
    harnessPercent: number;
    pluginPercent: number;
  }): void;
}

function parseInitialElements(html: string): Map<string, FakeElement> {
  const elements = new Map<string, FakeElement>();
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const id = match[1];
    const tag = match[0];
    if (id !== undefined && tag !== undefined) {
      elements.set(id, {
        dataset: {},
        hidden: /\shidden(?:\s|>|=)/.test(tag),
        textContent: "",
        value: 0
      });
    }
  }
  return elements;
}

async function renderStatus(search: string): Promise<RenderedStatus> {
  const [html, script] = await Promise.all([
    readFile(path.join(projectRoot, "src", "ui", "status.html"), "utf8"),
    readFile(path.join(projectRoot, "src", "ui", "status.js"), "utf8")
  ]);
  const elements = parseInitialElements(html);
  const body = { dataset: {} as Record<string, string> };
  let runtimeProgressListener: ((progress: {
    kind: "runtime-installing";
    phase: "download" | "verify" | "install";
    harnessPercent: number;
    pluginPercent: number;
  }) => void) | undefined;
  vm.runInNewContext(script, {
    URLSearchParams,
    Number,
    document: {
      body,
      querySelector: (selector: string) => selector.startsWith("#")
        ? elements.get(selector.slice(1)) ?? null
        : null
    },
    window: {
      location: { search },
      arkmeRuntimeStatus: {
        onProgress(listener: typeof runtimeProgressListener) {
          runtimeProgressListener = listener;
          return () => { runtimeProgressListener = undefined; };
        }
      }
    }
  });
  return {
    elements,
    emitRuntimeProgress(progress) {
      runtimeProgressListener?.(progress);
    }
  };
}

describe("status UI", () => {
  test("displays arkme as the client brand", async () => {
    const html = await readFile(path.join(projectRoot, "src", "ui", "status.html"), "utf8");

    expect(html).toContain("<title>arkme</title>");
    expect(html).toContain('aria-label="arkme"');
    expect(html).toContain('id="brand-name"');
  });

  test("shows the approved test identity without changing production startup copy", async () => {
    const production = await renderStatus("?kind=starting&environment=prod");
    expect(production.elements.get("brand-name")?.textContent).toBe("arkme");
    expect(production.elements.get("environment-badge")?.hidden).toBe(true);
    expect(production.elements.get("message")?.textContent).toBe("正在启动本地 Harness 服务");

    const testing = await renderStatus("?kind=starting&environment=test");
    expect(testing.elements.get("brand-name")?.textContent).toBe("arkme Test");
    expect(testing.elements.get("environment-badge")?.hidden).toBe(false);
    expect(testing.elements.get("environment-badge")?.textContent).toBe("测试环境");
    expect(testing.elements.get("message")?.textContent).toBe("正在准备测试环境运行服务");
  });

  test("loads the Arkme logo before the startup brand title", async () => {
    const html = await readFile(path.join(projectRoot, "src", "ui", "status.html"), "utf8");
    const logo = await readFile(path.join(projectRoot, "src", "ui", "arkme-logo.svg"), "utf8");

    expect(html).toContain("img-src 'self'");
    expect(html).toContain('<img class="brand-logo" src="./arkme-logo.svg" alt="" />');
    expect(logo).toContain('<svg');
  });

  test("declares a restrictive content security policy and controlled actions", async () => {
    const html = await readFile(path.join(projectRoot, "src", "ui", "status.html"), "utf8");

    expect(html).toContain("default-src 'none'");
    expect(html).toContain('href="app-action://retry"');
    expect(html).toContain('href="app-action://reload-runtime"');
    expect(html).toContain('href="app-action://choose-workspace"');
    expect(html).toContain('href="app-action://open-logs"');
  });

  test("renders query values as text instead of HTML", async () => {
    const script = await readFile(path.join(projectRoot, "src", "ui", "status.js"), "utf8");

    expect(script).toContain("textContent");
    expect(script).not.toContain("innerHTML");
  });

  test("shows separate Harness and Arkme installation progress with retry and logs recovery", async () => {
    const html = await readFile(path.join(projectRoot, "src", "ui", "status.html"), "utf8");
    const script = await readFile(path.join(projectRoot, "src", "ui", "status.js"), "utf8");

    expect(html).toContain('id="runtime-progress"');
    expect(html).toContain('id="harness-progress"');
    expect(html).toContain('id="plugin-progress"');
    expect(script).toContain('kind === "runtime-installing"');
    expect(script).toContain("正在准备运行环境");
  });

  test("keeps failure controls hidden before the status script initializes", async () => {
    const html = await readFile(path.join(projectRoot, "src", "ui", "status.html"), "utf8");
    const elements = parseInitialElements(html);

    expect(elements.get("spinner")?.hidden).toBe(false);
    expect(elements.get("failure-icon")?.hidden).toBe(true);
    expect(elements.get("workspace-row")?.hidden).toBe(true);
    expect(elements.get("actions")?.hidden).toBe(true);
  });

  test("renders a user-readable runtime failure and hides the unrelated workspace action", async () => {
    const query = new URLSearchParams({
      kind: "failed",
      title: "运行环境暂时不可用",
      message: "当前服务器提供的 Arkme 插件版本过低，与此版本的客户端不兼容。",
      suggestion: "请稍后重试；如果问题持续出现，请联系管理员。",
      technicalDetails: "插件版本 0.1.17，最低要求 0.1.18",
      showWorkspaceAction: "0"
    });
    const { elements } = await renderStatus(`?${query.toString()}`);

    expect(elements.get("title")?.textContent).toBe("运行环境暂时不可用");
    expect(elements.get("message")?.textContent).toBe("当前服务器提供的 Arkme 插件版本过低，与此版本的客户端不兼容。");
    expect(elements.get("failure-suggestion")?.textContent).toBe("请稍后重试；如果问题持续出现，请联系管理员。");
    expect(elements.get("technical-details")?.textContent).toBe("技术信息：插件版本 0.1.17，最低要求 0.1.18");
    expect(elements.get("choose-workspace-action")?.hidden).toBe(true);
  });

  test("shows only the approved reload action when a Bad Release blocks startup", async () => {
    const query = new URLSearchParams({
      kind: "failed",
      environment: "test",
      title: "当前运行环境无法使用",
      message: "检测到当前运行组件校验失败，Arkme 无法继续启动。",
      suggestion: "重新加载只会下载当前环境的运行组件，不会删除项目、设置、市集插件或其他用户数据。",
      showWorkspaceAction: "0",
      showReloadRuntimeAction: "1"
    });
    const { elements } = await renderStatus(`?${query.toString()}`);

    expect(elements.get("reload-runtime-action")?.hidden).toBe(false);
    expect(elements.get("retry-action")?.hidden).toBe(true);
    expect(elements.get("choose-workspace-action")?.hidden).toBe(true);
    expect(elements.get("environment-badge")?.textContent).toBe("测试环境");
  });

  test("keeps reload hidden for ordinary retryable launch failures", async () => {
    const { elements } = await renderStatus("?kind=failed&message=端口暂时不可用");

    expect(elements.get("reload-runtime-action")?.hidden).toBe(true);
    expect(elements.get("retry-action")?.hidden).toBe(false);
  });

  test("renders download, verification and installation as explicit stages", async () => {
    const { elements: verify } = await renderStatus("?kind=runtime-installing&phase=verify&harnessPercent=100&pluginPercent=100");
    expect(verify.get("download-stage")?.dataset.status).toBe("complete");
    expect(verify.get("verify-stage")?.dataset.status).toBe("current");
    expect(verify.get("install-stage")?.dataset.status).toBe("pending");
    expect(verify.get("runtime-progress")?.hidden).toBe(false);

    const { elements: install } = await renderStatus("?kind=runtime-installing&phase=install&harnessPercent=100&pluginPercent=100");
    expect(install.get("download-stage")?.dataset.status).toBe("complete");
    expect(install.get("verify-stage")?.dataset.status).toBe("complete");
    expect(install.get("install-stage")?.dataset.status).toBe("current");
  });

  test("updates runtime progress in place after the page has loaded", async () => {
    const rendered = await renderStatus("?kind=runtime-installing&phase=download&harnessPercent=12&pluginPercent=0");

    rendered.emitRuntimeProgress({
      kind: "runtime-installing",
      phase: "verify",
      harnessPercent: 100,
      pluginPercent: 100
    });

    expect(rendered.elements.get("harness-progress-label")?.textContent).toBe("100%");
    expect(rendered.elements.get("plugin-progress-label")?.textContent).toBe("100%");
    expect(rendered.elements.get("download-stage")?.dataset.status).toBe("complete");
    expect(rendered.elements.get("verify-stage")?.dataset.status).toBe("current");
  });
});
