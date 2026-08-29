import { describe, expect, test, vi } from "vitest";
import { createAppQuitGuard } from "../src/app-quit-guard.js";

describe("createAppQuitGuard", () => {
  test("allows updater-driven quitAndInstall after the app update flow prepared shutdown", () => {
    const stopHarness = vi.fn(async () => undefined);
    const closeDirectoryPicker = vi.fn(async () => undefined);
    const quit = vi.fn();
    const guard = createAppQuitGuard({ stopHarness, closeDirectoryPicker, quit });
    const event = { preventDefault: vi.fn() };

    guard.allowImmediateQuit();
    guard.handleBeforeQuit(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(stopHarness).not.toHaveBeenCalled();
    expect(closeDirectoryPicker).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  test("normal quit waits for Harness shutdown and then resumes app quit", async () => {
    const stopHarness = vi.fn(async () => undefined);
    const closeDirectoryPicker = vi.fn(async () => undefined);
    const quit = vi.fn();
    const guard = createAppQuitGuard({ stopHarness, closeDirectoryPicker, quit });
    const event = { preventDefault: vi.fn() };

    guard.handleBeforeQuit(event);
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(stopHarness).toHaveBeenCalledOnce();
    expect(closeDirectoryPicker).toHaveBeenCalledOnce();
  });
});
