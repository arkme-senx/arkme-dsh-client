import { expect, test } from 'vitest';
import * as cookies from '../src/harness-cookie-install.js';
import type { HarnessAuthSession } from '../src/harness-auth-session.js';

test('serialized cookie installation cannot let old abort cleanup erase the next generation', async () => {
  const stored = new Map<string,string>();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const installer = new cookies.HarnessCookieInstaller({set: async details => {if (details.value === 'first') await gate; stored.set(details.name,details.value);}, remove:async (_url,name) => {stored.delete(name);}});
  const a = new AbortController(); const b = new AbortController();
  const session = (value:string, signal:AbortSignal):HarnessAuthSession => ({url:'http://127.0.0.1:1234/',signal,cookie:{name:'dsh-auth-test',value,path:'/',httpOnly:true,sameSite:'strict'}});
  const first = installer.install(session('first',a.signal));
  const rejected = expect(first).rejects.toThrow();
  await Promise.resolve();
  a.abort();
  const second = installer.install(session('second',b.signal));
  release();
  await rejected;
  await second;
  expect(stored.get('dsh-auth-test')).toBe('second');
  a.abort(); await installer.idle();
  expect(stored.get('dsh-auth-test')).toBe('second');
  b.abort(); await installer.idle();
  expect(stored.size).toBe(0);
});
