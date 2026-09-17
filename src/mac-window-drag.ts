// Each adapted surface owns its drag regions; retained, inactive surfaces must
// not acquire drag hit areas merely because another adapted tab is active.
const MAC_WINDOW_DRAG_STYLES = ["conversation", "marketplace"].map(mode => {
  const root = `:root:has([data-arkme-window-drag-mode="${mode}"])`;
  const region = `${root} [data-arkme-window-drag-region="${mode}"]`;
  const controls = `:is(button, a, input, textarea, select, label, summary,
    [role]:not([role="tablist"]), [tabindex],
    [contenteditable]:not([contenteditable="false"]), [data-arkme-window-no-drag])`;
  return `
    ${root} #arkme-mac-window-drag-region {
      display: none !important;
      -webkit-app-region: no-drag !important;
    }
    ${region} * { -webkit-app-region: no-drag; }
    ${region} { -webkit-app-region: drag; }
    ${region} ${controls}, ${region} ${controls} * {
      -webkit-app-region: no-drag !important;
    }
    ${region}[data-arkme-window-drag-copy] > * {
      width: fit-content;
      max-width: 100%;
    }
  `;
}).join("\n") + `
  /* Include existing directory whitespace without moving controls or the list. */
  :root:has([data-arkme-window-drag-mode="conversation"]) [data-arkme-window-drag-directory] {
    margin: 0 !important;
    padding: 24px 16px 16px !important;
    box-sizing: border-box;
  }
`;

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
    const styleId = "arkme-mac-window-drag-style";
    document.getElementById(id)?.remove();
    document.getElementById(styleId)?.remove();
    const style = document.createElement("style");
    style.id = styleId;
    // The navigation owner publishes the active tab, even when other pages
    // remain mounted. Missing state deliberately keeps the legacy drag strip.
    style.textContent = ${JSON.stringify(MAC_WINDOW_DRAG_STYLES)};
    document.documentElement.appendChild(style);
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
