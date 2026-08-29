export interface TitleLockWindow {
  setTitle(title: string): void;
  on(
    event: "page-title-updated",
    listener: (event: { preventDefault(): void }) => void
  ): void;
}

export function lockWindowTitle(window: TitleLockWindow, title: string): void {
  window.setTitle(title);
  window.on("page-title-updated", (event) => event.preventDefault());
}
