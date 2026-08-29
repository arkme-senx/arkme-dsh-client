export interface ApplicationMenuAdapter<TMenu, TTemplate> {
  buildFromTemplate(template: TTemplate[]): TMenu;
  setApplicationMenu(menu: TMenu | null): void;
}

export function installApplicationMenuForPlatform<TMenu, TTemplate>(
  platform: NodeJS.Platform,
  menu: ApplicationMenuAdapter<TMenu, TTemplate>,
  template: TTemplate[]
): void {
  if (platform === "win32") {
    menu.setApplicationMenu(null);
    return;
  }

  menu.setApplicationMenu(menu.buildFromTemplate(template));
}
