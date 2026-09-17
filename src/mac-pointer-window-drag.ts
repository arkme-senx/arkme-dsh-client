interface DragWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
  isFullScreen(): boolean;
  isMaximized(): boolean;
  getPosition(): number[];
  setPosition(x: number, y: number, animate: boolean): void;
}

/** Main-process gesture state; IPC sender authorization belongs to the caller. */
export class MacPointerWindowDrag {
  private active: { id: string; x: number; y: number; origin: [number, number] } | undefined;
  constructor(private readonly platform: NodeJS.Platform, private readonly window: DragWindow) {}
  cancel(): void { this.active = undefined; }
  accept(value: unknown): void {
    if (this.platform !== "darwin") return;
    if (this.window.isDestroyed() || !this.window.isFocused() || !this.window.isVisible()
      || this.window.isFullScreen() || this.window.isMaximized()) { this.cancel(); return; }
    if (value === null || typeof value !== "object") return;
    const { kind, id, x, y } = value as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0 || id.length > 96) return;
    if (kind === "end") { if (this.active?.id === id) this.cancel(); return; }
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)
      || Math.abs(x) > 100_000 || Math.abs(y) > 100_000) return;
    if (kind === "begin") {
      // Use the pointerdown coordinates, not a later asynchronous cursor sample.
      const [windowX, windowY] = this.window.getPosition();
      if (windowX === undefined || windowY === undefined) return;
      this.active = { id, x, y, origin: [windowX, windowY] };
    } else if (kind === "move" && this.active?.id === id) {
      // Electron's native integer conversion rejects -0, which Math.round can
      // produce for fractional negative coordinates near the screen origin.
      this.window.setPosition(Math.round(this.active.origin[0] + x - this.active.x) + 0,
        Math.round(this.active.origin[1] + y - this.active.y) + 0, false);
    }
  }
}
