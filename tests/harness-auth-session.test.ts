import { createServer } from 'node:http';
import { expect, test } from 'vitest';
import * as auth from '../src/harness-auth-session.js';

test('chunked ANSI output captures only assigned loopback origin and redacts secrets', () => {
  const parser = new auth.HarnessLaunchOutput('http://127.0.0.1:41234/');
  expect(parser.push('\x1b[32mdsh web: http://127.0.0.1:41234/?to').text).toBe('');
  const result = parser.push('ken=secret\x1b[0m\n');
  expect(result.launchUrl).toBe('http://127.0.0.1:41234/?token=secret');
  expect(result.text).not.toContain('secret');
  expect(new auth.HarnessLaunchOutput('http://127.0.0.1:41234/').push('dsh web: http://evil.test:41234/?token=secret\n').launchUrl).toBeUndefined();
  expect(new auth.HarnessLaunchOutput('http://127.0.0.1:41234/').push('dsh web: http://127.0.0.1:41235/?token=secret\n').launchUrl).toBeUndefined();
});

test('exchanges token through manual 303 and verifies the clean page using the cookie', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url === '/?token=secret') { res.writeHead(303, {location: '/', 'set-cookie':'dsh-auth-test=v1.body.sig; Path=/; HttpOnly; SameSite=Strict'}); res.end(); }
    else { res.writeHead(req.headers.cookie === 'dsh-auth-test=v1.body.sig' ? 200 : 401); res.end('page'); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/`;
  try {
    const session = await auth.authenticateHarness(`${url}?token=secret`, url, new AbortController().signal);
    expect(session.url).toBe(url);
    expect(session.cookie.name).toBe('dsh-auth-test');
    expect(requests).toEqual(['/?token=secret', '/']);
    expect(JSON.stringify(session)).not.toContain('secret');
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('never follows an external redirect with token or cookie', async () => {
  const server = createServer((_req, res) => { res.writeHead(303, {location:'http://evil.test/', 'set-cookie':'dsh-auth-test=v1.body.sig; Path=/; HttpOnly; SameSite=Strict'}); res.end(); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/`;
  try { await expect(auth.authenticateHarness(`${url}?token=secret`, url, new AbortController().signal)).rejects.toThrow('redirect'); }
  finally { await new Promise<void>(r => server.close(() => r())); }
});
