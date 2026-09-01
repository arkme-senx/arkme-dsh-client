export interface AppQuitEvent {
  preventDefault(): void;
}

export interface AppQuitGuard {
  allowImmediateQuit(): void;
  handleBeforeQuit(event: AppQuitEvent): void;
}

export function createAppQuitGuard(options: {
  stopHarness: () => Promise<void>;
  closeDirectoryPicker: () => Promise<void> | void;
  closeDesktopCapabilities?: () => Promise<void> | void;
  clearNativeBadge?: () => Promise<void> | void;
  quit: () => void;
  onStopError?: (error: unknown) => void;
  onCloseError?: (error: unknown) => void;
  onDesktopCapabilitiesCloseError?: (error: unknown) => void;
  onBadgeClearError?: (error: unknown) => void;
}): AppQuitGuard {
  let shutdownStarted = false;
  let shutdownComplete = false;
  let immediateQuitAllowed = false;

  return {
    allowImmediateQuit(): void {
      immediateQuitAllowed = true;
      shutdownComplete = true;
    },

    handleBeforeQuit(event: AppQuitEvent): void {
      if (immediateQuitAllowed || shutdownComplete) return;
      event.preventDefault();
      if (shutdownStarted) return;
      shutdownStarted = true;
      void (async () => {
        try {
          await options.stopHarness();
        } catch (error) {
          options.onStopError?.(error);
          // The detached Harness may still be alive. Keep the desktop process,
          // bridges, and process handle available so a later quit request can
          // retry shutdown instead of orphaning the child.
          shutdownStarted = false;
          return;
        }
        try {
          await options.closeDirectoryPicker();
        } catch (error) {
          options.onCloseError?.(error);
        }
        try {
          await options.closeDesktopCapabilities?.();
        } catch (error) {
          options.onDesktopCapabilitiesCloseError?.(error);
        }
        try {
          await options.clearNativeBadge?.();
        } catch (error) {
          options.onBadgeClearError?.(error);
        }
        shutdownComplete = true;
        options.quit();
      })();
    }
  };
}
