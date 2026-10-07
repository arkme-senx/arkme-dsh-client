import { randomUUID } from "node:crypto";
import type { DesktopAccountScopeIdentity } from "./desktop-capability-bridge.js";

interface PendingTransition {
  ref: string;
  identity: DesktopAccountScopeIdentity;
  prepared: boolean;
  abort: AbortController;
  cleanup?: () => void;
}

/** Owns the one transition whose credentials have not yet been committed. */
export class DesktopAccountScopeTransitions {
  private pending: PendingTransition | undefined;

  get active(): boolean { return this.pending !== undefined; }

  async prepare(
    identity: DesktopAccountScopeIdentity,
    effects: { enter(): Promise<void>; restore(): Promise<void> },
    callerSignal?: AbortSignal
  ): Promise<{ transitionRef: string }> {
    callerSignal?.throwIfAborted();
    if (this.pending !== undefined) throw new Error("DSH account scope transition is already active");
    const pending: PendingTransition = {
      ref: `scope-transition-${randomUUID()}`, identity, prepared: false, abort: new AbortController()
    };
    this.pending = pending;
    const signal = callerSignal === undefined ? pending.abort.signal : AbortSignal.any([callerSignal, pending.abort.signal]);
    const expired = () => {
      // After prepare returns, credentials may already have changed. Retire
      // the lease without revealing the old account; startup must attest again.
      if (pending.prepared && this.pending === pending) this.reset();
    };
    signal.addEventListener("abort", expired, { once: true });
    pending.cleanup = () => { signal.removeEventListener("abort", expired); };
    try {
      await waitForPreparation(effects.enter(), signal);
      signal.throwIfAborted();
      if (this.pending !== pending) throw new Error("DSH account scope transition is stale");
      pending.prepared = true;
      return { transitionRef: pending.ref };
    } catch (error) {
      if (this.pending === pending) {
        // Keep the slot occupied while restoring navigation; a retry must not
        // race a late waiting-page load or restore over a newer account.
        try { await effects.restore(); }
        finally {
          pending.cleanup();
          if (this.pending === pending) this.pending = undefined;
        }
      }
      throw error;
    }
  }

  prepared(transitionRef: string): { identity: DesktopAccountScopeIdentity } {
    const pending = this.pending;
    if (pending?.ref !== transitionRef || !pending.prepared) throw new Error("DSH account scope transition is stale");
    return { identity: pending.identity };
  }

  complete(transitionRef: string): void {
    this.prepared(transitionRef);
    this.pending?.cleanup?.();
    this.pending = undefined;
  }

  reset(): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.cleanup?.();
    pending?.abort.abort();
  }
}

function waitForPreparation(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    operation.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
