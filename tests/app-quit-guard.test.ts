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

  test("keeps bridges and app alive after stop failure, then retries on the next quit request", async () => {
    const stopHarness = vi.fn()
      .mockRejectedValueOnce(new Error("signal failed"))
      .mockResolvedValueOnce(undefined);
    const closeDirectoryPicker = vi.fn(async () => undefined);
    const closeDesktopCapabilities = vi.fn(async () => undefined);
    const clearNativeBadge = vi.fn();
    const quit = vi.fn();
    const onStopError = vi.fn();
    const guard = createAppQuitGuard({
      stopHarness,
      closeDirectoryPicker,
      closeDesktopCapabilities,
      clearNativeBadge,
      quit,
      onStopError
    });
    const firstEvent = { preventDefault: vi.fn() };

    guard.handleBeforeQuit(firstEvent);
    await vi.waitFor(() => expect(onStopError).toHaveBeenCalledOnce());

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(closeDirectoryPicker).not.toHaveBeenCalled();
    expect(closeDesktopCapabilities).not.toHaveBeenCalled();
    expect(clearNativeBadge).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();

    const retryEvent = { preventDefault: vi.fn() };
    guard.handleBeforeQuit(retryEvent);
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    expect(retryEvent.preventDefault).toHaveBeenCalledOnce();
    expect(stopHarness).toHaveBeenCalledTimes(2);
    expect(closeDirectoryPicker).toHaveBeenCalledOnce();
    expect(closeDesktopCapabilities).toHaveBeenCalledOnce();
    expect(clearNativeBadge).toHaveBeenCalledOnce();
  });

  test("coalesces repeated before-quit events while Harness shutdown is pending", async () => {
    let releaseStop!: () => void;
    const stopHarness = vi.fn(async () => {
      await new Promise<void>(resolve => { releaseStop = resolve; });
    });
    const closeDirectoryPicker = vi.fn(async () => undefined);
    const quit = vi.fn();
    const guard = createAppQuitGuard({ stopHarness, closeDirectoryPicker, quit });
    const firstEvent = { preventDefault: vi.fn() };
    const duplicateEvent = { preventDefault: vi.fn() };

    guard.handleBeforeQuit(firstEvent);
    guard.handleBeforeQuit(duplicateEvent);

    expect(stopHarness).toHaveBeenCalledOnce();
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(duplicateEvent.preventDefault).toHaveBeenCalledOnce();
    releaseStop();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(closeDirectoryPicker).toHaveBeenCalledOnce();
  });

  test("closes both bridges and clears the native badge even when an earlier cleanup fails", async () => {
    const closeDesktopCapabilities = vi.fn(async () => undefined);
    const clearNativeBadge = vi.fn();
    const quit = vi.fn();
    const onCloseError = vi.fn();
    const guard = createAppQuitGuard({
      stopHarness: vi.fn(async () => undefined),
      closeDirectoryPicker: vi.fn(async () => { throw new Error("picker failed"); }),
      closeDesktopCapabilities,
      clearNativeBadge,
      quit,
      onCloseError
    });

    guard.handleBeforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    expect(onCloseError).toHaveBeenCalledOnce();
    expect(closeDesktopCapabilities).toHaveBeenCalledOnce();
    expect(clearNativeBadge).toHaveBeenCalledOnce();
  });
});
