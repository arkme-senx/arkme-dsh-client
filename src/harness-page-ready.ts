import { randomUUID } from 'node:crypto';

/** rc2 reports caught React slot failures through this local renderer diagnostic. */
export function localHarnessMountFailure(level: number, message: string): Error | undefined {
  if (level !== 3 || !/^slot entry crashed in ['"]/.test(message)) return undefined;
  return new Error(`Harness local UI failed to mount: ${message}`);
}

export function settleHarnessPageRendering(
  execute: (script: string) => Promise<unknown>, signal: AbortSignal, timeoutMs = 5_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error === undefined) resolve(); else reject(error);
    };
    const abort = () => finish(new Error('Harness page rendering cancelled'));
    const timer = setTimeout(() => finish(new Error('Harness page rendering timed out')), timeoutMs);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) { abort(); return; }
    void Promise.resolve().then(() => execute(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'
    )).then(() => finish(), finish);
  });
}

export interface HarnessPageSender { webContentsId: number; isMainFrame: boolean; url: string; }
interface PendingPage {
  origin: string;
  nonce: string;
  settle(error?: Error): void;
}

/** Main owns both document generation and nonce; renderer supplies no identifiers. */
export class HarnessPageReadiness {
  private readonly pages = new Map<number, PendingPage>();

  arm(webContentsId: number, url: string, signal: AbortSignal, timeoutMs = 30_000): {ready: Promise<void>; dispose(): void} {
    this.pages.get(webContentsId)?.settle(new Error('Harness page probe superseded'));
    let page!: PendingPage;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const onAbort = () => page.settle(new Error('Harness page probe cancelled'));
    const ready = new Promise<void>((resolve, reject) => {
      page = {origin: new URL(url).origin, nonce: randomUUID(), settle: error => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (this.pages.get(webContentsId) === page) this.pages.delete(webContentsId);
        if (error === undefined) resolve(); else reject(error);
      }};
    });
    this.pages.set(webContentsId, page);
    timer = setTimeout(() => page.settle(new Error('Harness plugin page readiness timed out')), timeoutMs);
    signal.addEventListener('abort', onAbort, {once:true});
    if (signal.aborted) onAbort();
    return {ready, dispose: () => page.settle(new Error('Harness page probe closed'))};
  }

  navigation(webContentsId: number): void {
    const page = this.pages.get(webContentsId);
    if (page !== undefined) page.nonce = randomUUID();
  }

  nonce(sender: HarnessPageSender): string | null {
    const page = this.pages.get(sender.webContentsId);
    if (page === undefined || !sender.isMainFrame) return null;
    try { return new URL(sender.url).origin === page.origin ? page.nonce : null; }
    catch { return null; }
  }

  accept(sender: HarnessPageSender, nonce: unknown): boolean {
    if (typeof nonce !== 'string' || this.nonce(sender) !== nonce) return false;
    this.pages.get(sender.webContentsId)!.settle();
    return true;
  }
}
