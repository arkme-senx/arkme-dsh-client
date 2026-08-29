import { describe, expect, test } from "vitest";
import { createStatusPageUrl } from "../src/status-url.js";

describe("createStatusPageUrl", () => {
  test("encodes the startup workspace", () => {
    const result = new URL(
      createStatusPageUrl("/app/dist/ui/status.html", {
        kind: "starting",
        workspacePath: "/Users/test/项目"
      })
    );

    expect(result.protocol).toBe("file:");
    expect(result.searchParams.get("kind")).toBe("starting");
    expect(result.searchParams.get("workspace")).toBe("/Users/test/项目");
  });

  test("marks only test status pages as the test environment", () => {
    const production = new URL(createStatusPageUrl("/app/dist/ui/status.html", {
      kind: "starting",
      workspacePath: "/Users/test/project"
    }));
    const testing = new URL(createStatusPageUrl("/app/dist/ui/status.html", {
      kind: "starting",
      workspacePath: "/Users/test/project"
    }, "test"));

    expect(production.searchParams.get("environment")).toBe("prod");
    expect(testing.searchParams.get("environment")).toBe("test");
  });

  test("encodes a failure without exposing the full log in the URL", () => {
    const result = new URL(
      createStatusPageUrl("/app/dist/ui/status.html", {
        kind: "failed",
        workspacePath: "/Users/test/project",
        message: "Harness exited with code 1",
        logPath: "/private/logs/harness.log"
      })
    );

    expect(result.searchParams.get("kind")).toBe("failed");
    expect(result.searchParams.get("message")).toBe("Harness exited with code 1");
    expect(result.searchParams.has("logPath")).toBe(false);
  });

  test("encodes user-readable runtime failure details and hides the workspace action", () => {
    const state = {
      kind: "failed" as const,
      message: "当前服务器提供的 Arkme 插件版本过低，与此版本的客户端不兼容。",
      logPath: "/private/logs/desktop-startup.log",
      displayTitle: "运行环境暂时不可用",
      suggestion: "请稍后重试；如果问题持续出现，请联系管理员。",
      technicalDetails: "插件版本 0.1.17，最低要求 0.1.18",
      showWorkspaceAction: false
    };

    const result = new URL(createStatusPageUrl("/app/dist/ui/status.html", state));

    expect(result.searchParams.get("title")).toBe("运行环境暂时不可用");
    expect(result.searchParams.get("message")).toBe("当前服务器提供的 Arkme 插件版本过低，与此版本的客户端不兼容。");
    expect(result.searchParams.get("suggestion")).toBe("请稍后重试；如果问题持续出现，请联系管理员。");
    expect(result.searchParams.get("technicalDetails")).toBe("插件版本 0.1.17，最低要求 0.1.18");
    expect(result.searchParams.get("showWorkspaceAction")).toBe("0");
    expect(result.searchParams.has("logPath")).toBe(false);
  });

  test("encodes bounded runtime component progress", () => {
    const result = new URL(createStatusPageUrl("/app/dist/ui/status.html", {
      kind: "runtime-installing",
      phase: "download",
      harnessPercent: 82,
      pluginPercent: 0
    }));

    expect(result.searchParams.get("phase")).toBe("download");
    expect(result.searchParams.get("harnessPercent")).toBe("82");
    expect(result.searchParams.get("pluginPercent")).toBe("0");
  });

  test("exposes only the controlled reload action for a blocked Bad Release", () => {
    const result = new URL(createStatusPageUrl("/app/dist/ui/status.html", {
      kind: "failed",
      message: "检测到当前运行组件校验失败，Arkme 无法继续启动。",
      logPath: "/private/logs/desktop-startup.log",
      displayTitle: "当前运行环境无法使用",
      showWorkspaceAction: false,
      showReloadRuntimeAction: true
    }));

    expect(result.searchParams.get("showReloadRuntimeAction")).toBe("1");
  });
});
