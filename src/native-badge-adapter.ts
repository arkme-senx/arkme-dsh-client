import type { NativeBadgeAdapter, NativeBadgeMode } from "./native-badge.js";

export interface WindowsBadgeWindow<TImage = unknown> {
  isDestroyed(): boolean;
  setOverlayIcon(image: TImage | null, description: string): void;
}

interface DesktopNativeBadgeAdapterOptions<TImage> {
  platform: NodeJS.Platform;
  setAppBadgeCount(count: number): boolean;
  setMacDockBadge(text: string): void;
  linuxBadgeSupported(): boolean;
  getWindowsWindow(): WindowsBadgeWindow<TImage> | null;
  getWindowsDotImage(): TImage;
  windowsDescription?: string;
}

export function createDesktopNativeBadgeAdapter<TImage>(
  options: DesktopNativeBadgeAdapterOptions<TImage>
): NativeBadgeAdapter {
  return {
    get mode(): NativeBadgeMode {
      return resolveNativeBadgeMode(options.platform, options.linuxBadgeSupported);
    },
    apply(count: number): boolean {
      const mode = resolveNativeBadgeMode(options.platform, options.linuxBadgeSupported);
      if (mode === "unsupported") return false;
      if (options.platform === "darwin") {
        try {
          options.setMacDockBadge(count === 0 ? "" : String(count));
          return true;
        } catch {
          return false;
        }
      }
      if (mode === "count") return options.setAppBadgeCount(count);

      const window = options.getWindowsWindow();
      if (window === null || window.isDestroyed()) return false;
      window.setOverlayIcon(
        count === 0 ? null : options.getWindowsDotImage(),
        count === 0 ? "" : (options.windowsDescription ?? "Arkme unread messages")
      );
      return true;
    }
  };
}

export function resolveNativeBadgeMode(
  platform: NodeJS.Platform,
  linuxBadgeSupported: () => boolean
): NativeBadgeMode {
  if (platform === "darwin") return "count";
  if (platform === "win32") return "dot";
  if (platform === "linux" && linuxBadgeSupported()) return "count";
  return "unsupported";
}
