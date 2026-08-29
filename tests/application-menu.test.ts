import { describe, expect, test, vi } from "vitest";

describe("desktop application menu policy", () => {
  test("hides the native application menu on Windows", async () => {
    const policy = await import("../src/application-menu.js").catch(() => ({}));
    const install = (policy as {
      installApplicationMenuForPlatform?: (
        platform: NodeJS.Platform,
        menu: { buildFromTemplate(template: unknown[]): unknown; setApplicationMenu(menu: unknown): void },
        template: unknown[]
      ) => void;
    }).installApplicationMenuForPlatform;
    const builtMenu = { native: true };
    const menu = {
      buildFromTemplate: vi.fn(() => builtMenu),
      setApplicationMenu: vi.fn()
    };

    install?.("win32", menu, [{ label: "文件" }]);

    expect(menu.buildFromTemplate).not.toHaveBeenCalled();
    expect(menu.setApplicationMenu).toHaveBeenCalledOnce();
    expect(menu.setApplicationMenu).toHaveBeenCalledWith(null);
  });

  test("keeps the native application menu on macOS and Linux", async () => {
    const policy = await import("../src/application-menu.js").catch(() => ({}));
    const install = (policy as {
      installApplicationMenuForPlatform?: (
        platform: NodeJS.Platform,
        menu: { buildFromTemplate(template: unknown[]): unknown; setApplicationMenu(menu: unknown): void },
        template: unknown[]
      ) => void;
    }).installApplicationMenuForPlatform;

    for (const platform of ["darwin", "linux"] satisfies NodeJS.Platform[]) {
      const builtMenu = { platform };
      const template = [{ label: "文件" }];
      const menu = {
        buildFromTemplate: vi.fn(() => builtMenu),
        setApplicationMenu: vi.fn()
      };

      install?.(platform, menu, template);

      expect(menu.buildFromTemplate).toHaveBeenCalledWith(template);
      expect(menu.setApplicationMenu).toHaveBeenCalledWith(builtMenu);
    }
  });
});
