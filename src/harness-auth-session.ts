import {annotateHarnessFailure, diagnosticNetworkCode} from './harness-process-lifetime.js';
import { stripVTControlCharacters } from 'node:util';

export interface HarnessAuthSession {
  readonly url: string;
  readonly cookie: { name: string; value: string; path: '/'; httpOnly: true; sameSite: 'strict' };
  readonly signal: AbortSignal;
}

function validLaunchUrl(value: string, root: string): boolean {
  try {
    const url = new URL(value);
    const expected = new URL(root);
    return expected.protocol === 'http:' && expected.hostname === '127.0.0.1'
      && url.origin === expected.origin && !url.username && !url.password
      && url.pathname === '/' && !url.hash
      && [...url.searchParams.keys()].join(',') === 'token'
      && /^[A-Za-z0-9_-]{1,512}$/.test(url.searchParams.get('token') ?? '');
  } catch { return false; }
}

export function redactHarnessSecrets(text: string): string {
  return text.replace(/([?&]token=)[^\s&#]*/gi, '$1[redacted]')
    .replace(/(dsh-auth-[A-Za-z0-9_-]+=)[^\s;]*/g, '$1[redacted]');
}

/** Holds at most one bounded line; incomplete lines never reach logs. */
export class HarnessLaunchOutput {
  private pending = '';
  private dropping = false;
  constructor(private readonly root: string) {}
  clear(): void { this.pending = ''; this.dropping = false; }
  push(chunk: string): { text: string; launchUrl?: string } {
    let text = '';
    let launchUrl: string | undefined;
    for (const character of chunk) {
      if (character === '\n') {
        if (!this.dropping) {
          const line = stripVTControlCharacters(this.pending);
          const match = /^\s*dsh web:\s*(\S+)\s*$/.exec(line);
          if (match?.[1] && validLaunchUrl(match[1], this.root)) launchUrl = match[1];
          text += `${redactHarnessSecrets(line)}\n`;
        } else text += '[overlong process output omitted]\n';
        text = text.slice(-64 * 1024);
        this.clear();
      } else if (!this.dropping) {
        this.pending += character;
        if (this.pending.length > 16_384) { this.pending = ''; this.dropping = true; }
      }
    }
    return { text, ...(launchUrl === undefined ? {} : {launchUrl}) };
  }
}

export function harnessCookieHeader(session: HarnessAuthSession): string {
  session.signal.throwIfAborted();
  return `${session.cookie.name}=${session.cookie.value}`;
}

export async function authenticateHarness(launchUrl: string, root: string, signal: AbortSignal): Promise<HarnessAuthSession> {
  if (!validLaunchUrl(launchUrl, root)) throw new Error('Invalid Harness authentication URL');
  const started = Date.now();
  let authPhase = 'token-exchange';
  let status: number | undefined;
  try {
    const response = await fetch(launchUrl, {redirect: 'manual', signal});
    status = response.status;
    authPhase = 'token-response';
    await response.body?.cancel();
    if (response.status !== 303) throw new Error('Harness authentication exchange failed');
    const location = response.headers.get('location');
    if (location === null || new URL(location, root).href !== root) throw new Error('Invalid Harness authentication redirect');
    const cookies = response.headers.getSetCookie();
    if (cookies.length !== 1) throw new Error('Invalid Harness authentication cookie');
    const parts = cookies[0]!.split(';').map(part => part.trim());
    const match = /^(dsh-auth-[A-Za-z0-9_-]+)=([A-Za-z0-9_.-]+)$/.exec(parts[0]!);
    const attributes = parts.slice(1).map(part => part.toLowerCase());
    if (!match || !attributes.includes('httponly') || !attributes.includes('samesite=strict')
      || !attributes.includes('path=/') || attributes.some(part => part.startsWith('domain='))) {
      throw new Error('Invalid Harness authentication cookie');
    }
    const session: HarnessAuthSession = {url: root, cookie: {name: match[1]!, value: match[2]!, path: '/', httpOnly: true, sameSite: 'strict'}, signal};
    authPhase = 'authenticated-page';
    status = undefined;
    const clean = await fetch(root, {headers: {cookie: harnessCookieHeader(session)}, redirect: 'manual', signal});
    status = clean.status;
    authPhase = 'page-response';
    await clean.body?.cancel();
    if (!clean.ok) throw new Error('Harness authenticated page unavailable');
    signal.throwIfAborted();
    return session;
  } catch (error) {
    // Fetch diagnostics may contain the secret request URL; expose only fixed errors.
    const explicit = error instanceof Error && /^(Invalid Harness|Harness auth)/.test(error.message);
    const reported = explicit ? error : new Error(signal.aborted ? 'Harness authentication cancelled' : 'Harness authentication failed');
    const errorCode = diagnosticNetworkCode(error);
    throw annotateHarnessFailure(reported, {authPhase, diagnosticReason: signal.aborted ? (signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'request-timeout' : 'cancelled') : explicit ? 'protocol-error' : 'network-error',
      elapsedMs: Math.max(0, Date.now() - started), ...(status === undefined ? {} : {status}), ...(errorCode === undefined ? {} : {errorCode})});
  }
}
