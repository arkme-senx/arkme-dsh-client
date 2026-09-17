import { describe, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

describe("macOS window drag region", () => {
  test.skipIf(process.platform !== "darwin")("switches native drag styles with active tab state, restores fallback and installs idempotently", async () => {
    const { installMacWindowDragRegion } = await import("../src/mac-window-drag.js");
    let script = "";
    await installMacWindowDragRegion("darwin", {
      isDestroyed: () => false,
      webContents: { executeJavaScript: async value => { script = value; } }
    });
    const env: NodeJS.ProcessEnv = { ...process.env, ARKME_TEST_DRAG_SCRIPT: script };
    delete env.ELECTRON_RUN_AS_NODE;
    const electron = createRequire(import.meta.url)("electron") as string;
    const { stdout } = await promisify(execFile)(electron, [
      fileURLToPath(new URL("./fixtures/mac-window-drag.cjs", import.meta.url))
    ], { env, timeout: 25_000 });
    expect(stdout).toContain("mac-window-drag passed");
  }, 30_000);

  test("installs an idempotent drag region only on live macOS windows", async () => {
    const policy = await import("../src/mac-window-drag.js").catch(() => ({}));
    const install = (policy as {
      installMacWindowDragRegion?: (
        platform: NodeJS.Platform,
        window: { isDestroyed(): boolean; webContents: { executeJavaScript(script: string): Promise<unknown> } }
      ) => Promise<void>;
    }).installMacWindowDragRegion;
    const executeJavaScript = vi.fn(async (_script: string) => undefined);
    const window = { isDestroyed: () => false, webContents: { executeJavaScript } };

    await install?.("darwin", window);

    expect(executeJavaScript).toHaveBeenCalledOnce();
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain("arkme-mac-window-drag-region");
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain('WebkitAppRegion: "drag"');

    executeJavaScript.mockClear();
    await install?.("win32", window);
    await install?.("darwin", { ...window, isDestroyed: () => true });
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  test("reinstalls the drag region after every main-frame load, including late deep links", async () => {
    const policy = await import("../src/mac-window-drag.js");
    const register = (policy as typeof policy & {
      registerMacWindowDragRegionReinstall?: (
        platform: NodeJS.Platform,
        window: {
          isDestroyed(): boolean;
          webContents: {
            executeJavaScript(script: string): Promise<unknown>;
            on(event: "did-finish-load", listener: () => void): void;
          };
        },
        onError: (error: unknown) => void
      ) => void;
    }).registerMacWindowDragRegionReinstall;
    let didFinishLoad: (() => void) | undefined;
    const executeJavaScript = vi.fn(async (_script: string) => undefined);
    const onError = vi.fn();
    const window = {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript,
        on: (_event: "did-finish-load", listener: () => void) => { didFinishLoad = listener; }
      }
    };

    register?.("darwin", window, onError);
    didFinishLoad?.();
    await vi.waitFor(() => { expect(executeJavaScript).toHaveBeenCalledTimes(1); });
    didFinishLoad?.();
    await vi.waitFor(() => { expect(executeJavaScript).toHaveBeenCalledTimes(2); });
    expect(onError).not.toHaveBeenCalled();
  });
});
