import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { BrowserWindow, OpenDialogReturnValue } from 'electron';

type Owner = BrowserWindow;
type Diagnostic = (details: Record<string, unknown>) => void;

/** The native dialog owns its lifetime; renderer visibility is diagnostic only. */
export class NativeRecordingPicker {
  private readonly active = new Set<number>();
  constructor(
    private readonly show: (owner: Owner) => Promise<OpenDialogReturnValue>,
    private readonly diagnostic: Diagnostic,
  ) {}

  async pick(owner: Owner, valid: () => boolean): Promise<OpenDialogReturnValue> {
    if (owner.isDestroyed() || !valid()) throw new Error('录音导入窗口已关闭或账号已切换');
    if (this.active.has(owner.id)) throw new Error('文件选择窗口已打开，请先完成选择或取消');
    this.active.add(owner.id);
    const requestId = randomUUID();
    const started = performance.now();
    const report = (event: string, details: Record<string, unknown> = {}) => {
      try {
        const destroyed = owner.isDestroyed();
        this.diagnostic({ event, requestId, backend: 'desktop', elapsedMillis: Math.round(performance.now() - started),
          windowId: owner.id, destroyed, ...(!destroyed ? { visible: owner.isVisible(), focused: owner.isFocused(),
            minimized: owner.isMinimized(), fullscreen: owner.isFullScreen(), bounds: owner.getBounds() } : {}), ...details });
      } catch { /* Logging must never break the system chooser. */ }
    };
    const events = ['blur', 'focus', 'show', 'hide', 'minimize', 'restore', 'resize', 'enter-full-screen', 'leave-full-screen', 'closed'] as const;
    const emitter: EventEmitter = owner;
    const listeners: Array<() => void> = events.map(event => {
      const listener = () => report(`window-${event}`);
      emitter.on(event, listener);
      return () => { emitter.removeListener(event, listener); };
    });
    const gone = () => report('renderer-gone');
    owner.webContents.on('render-process-gone', gone);
    listeners.push(() => { owner.webContents.removeListener('render-process-gone', gone); });
    report('requested');
    try {
      const selected = await this.show(owner);
      if (owner.isDestroyed() || !valid()) throw new Error('录音导入窗口已关闭或账号已切换');
      // A native canceled result is recorded without claiming who initiated it.
      report('resolved', { canceled: selected.canceled, count: selected.canceled ? 0 : selected.filePaths.length });
      return selected;
    } catch (error) {
      report('rejected', { errorName: error instanceof Error ? error.name : 'Error' });
      throw error;
    } finally {
      for (const dispose of listeners) dispose();
      this.active.delete(owner.id);
    }
  }
}
