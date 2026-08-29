export interface MacWindowDragTarget {
  isDestroyed(): boolean;
  webContents: {
    executeJavaScript(script: string): Promise<unknown>;
  };
}

export interface MacWindowDragLoadTarget extends MacWindowDragTarget {
  webContents: MacWindowDragTarget["webContents"] & {
    on(event: "did-finish-load", listener: () => void): void;
  };
}

export async function installMacWindowDragRegion(
  platform: NodeJS.Platform,
  window: MacWindowDragTarget
): Promise<void> {
  if (platform !== "darwin" || window.isDestroyed()) return;

  await window.webContents.executeJavaScript(`(() => {
    const id = "arkme-mac-window-drag-region";
    document.getElementById(id)?.remove();
    const region = document.createElement("div");
    region.id = id;
    region.setAttribute("aria-hidden", "true");
    Object.assign(region.style, {
      position: "fixed",
      top: "0",
      left: "72px",
      right: "0",
      height: "28px",
      zIndex: "2147483647",
      WebkitAppRegion: "drag",
      userSelect: "none"
    });
    document.documentElement.appendChild(region);
  })()`);
}

export function registerMacWindowDragRegionReinstall(
  platform: NodeJS.Platform,
  window: MacWindowDragLoadTarget,
  onError: (error: unknown) => void
): void {
  window.webContents.on("did-finish-load", () => {
    void installMacWindowDragRegion(platform, window).catch(onError);
  });
}
