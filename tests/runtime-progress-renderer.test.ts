import { afterEach, describe, expect, test, vi } from "vitest";
import { createCoalescedAsyncRenderer } from "../src/runtime/progress-renderer.js";
import * as progressRendererModule from "../src/runtime/progress-renderer.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime progress renderer", () => {
  test("coalesces rapid updates and serializes the latest render", async () => {
    vi.useFakeTimers();
    const rendered: number[] = [];
    const renderer = createCoalescedAsyncRenderer<number>(async value => {
      rendered.push(value);
    }, 100);

    renderer.schedule(1);
    renderer.schedule(2);
    renderer.schedule(3);
    await vi.advanceTimersByTimeAsync(100);
    await renderer.flush();
    expect(rendered).toEqual([3]);

    renderer.schedule(4);
    await renderer.flush();
    expect(rendered).toEqual([3, 4]);
  });

  test("loads the progress page once and streams later updates without navigating", async () => {
    const createRuntimeProgressPageRenderer = (
      progressRendererModule as Record<string, unknown>
    ).createRuntimeProgressPageRenderer;
    expect(createRuntimeProgressPageRenderer).toBeTypeOf("function");
    if (typeof createRuntimeProgressPageRenderer !== "function") return;

    let currentUrl = "about:blank";
    const loadedUrls: string[] = [];
    const streamed: unknown[] = [];
    const render = createRuntimeProgressPageRenderer({
      getCurrentUrl: () => currentUrl,
      async loadUrl(url: string) {
        loadedUrls.push(url);
        currentUrl = url;
      },
      sendProgress(progress: unknown) {
        streamed.push(progress);
      }
    }, "/Applications/arkme.app/Contents/Resources/app.asar/dist/ui/status.html") as (
      progress: {
        kind: "runtime-installing";
        phase: "download" | "verify" | "install";
        harnessPercent: number;
        pluginPercent: number;
      }
    ) => Promise<void>;

    await render({ kind: "runtime-installing", phase: "download", harnessPercent: 1, pluginPercent: 0 });
    await render({ kind: "runtime-installing", phase: "download", harnessPercent: 2, pluginPercent: 0 });

    expect(loadedUrls).toHaveLength(1);
    expect(streamed).toEqual([
      { kind: "runtime-installing", phase: "download", harnessPercent: 2, pluginPercent: 0 }
    ]);
  });

  test("loads test runtime progress with the test identity marker", async () => {
    let loadedUrl = "";
    const render = progressRendererModule.createRuntimeProgressPageRenderer({
      getCurrentUrl: () => "about:blank",
      async loadUrl(url: string) { loadedUrl = url; },
      sendProgress() {}
    }, "/Applications/arkme Test.app/Contents/Resources/app.asar/dist/ui/status.html", "test");

    await render({
      kind: "runtime-installing",
      phase: "download",
      harnessPercent: 1,
      pluginPercent: 0
    });

    expect(new URL(loadedUrl).searchParams.get("environment")).toBe("test");
  });
});
