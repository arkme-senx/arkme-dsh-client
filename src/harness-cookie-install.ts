import type { HarnessAuthSession } from './harness-auth-session.js';
interface CookieStore {
  set(details: {url: string; name:string; value:string; path:'/'; httpOnly:true; sameSite:'strict'}): Promise<void>;
  remove(url:string, name:string): Promise<void>;
}

/** Serialize Chromium cookie mutations so old-generation aborts cannot delete new cookies. */
export class HarnessCookieInstaller {
  private queue: Promise<void> = Promise.resolve();
  private current: {session: HarnessAuthSession; url:string; name:string} | undefined;
  constructor(private readonly store: CookieStore) {}

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  idle(): Promise<void> { return this.queue; }

  install(session: HarnessAuthSession): Promise<void> {
    const entry = {session, url:session.url, name:session.cookie.name};
    const revoke = () => { void this.enqueue(async () => {
      if (this.current !== entry) return;
      await this.store.remove(entry.url, entry.name);
      this.current = undefined;
    }).catch(() => undefined); };
    session.signal.addEventListener('abort', revoke, {once:true});
    return this.enqueue(async () => {
      session.signal.throwIfAborted();
      if (this.current !== undefined) {
        await this.store.remove(this.current.url, this.current.name);
        this.current = undefined;
      }
      await this.store.set({url:session.url, ...session.cookie});
      this.current = entry;
      if (session.signal.aborted) {
        await this.store.remove(entry.url, entry.name);
        this.current = undefined;
        session.signal.throwIfAborted();
      }
    }).catch(error => {
      session.signal.removeEventListener('abort', revoke);
      throw error;
    });
  }
}
