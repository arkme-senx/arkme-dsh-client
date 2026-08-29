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
  quit: () => void;
  onStopError?: (error: unknown) => void;
  onCloseError?: (error: unknown) => void;
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
      void options.stopHarness()
        .catch((error: unknown) => {
          options.onStopError?.(error);
        })
        .then(async () => {
          await options.closeDirectoryPicker();
        })
        .catch((error: unknown) => {
          options.onCloseError?.(error);
        })
        .finally(() => {
          shutdownComplete = true;
          options.quit();
        });
    }
  };
}
