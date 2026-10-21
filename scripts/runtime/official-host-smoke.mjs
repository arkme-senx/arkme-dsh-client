import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';

// Host-only integration: no Arkme plugin, account, existing profile or renderer.
const runtime = path.resolve(process.argv[2] ?? '.runtime/dsh-021-harness-only');
const reportPath = path.resolve(process.argv[3] ?? '.runtime/harness-021-official-boot.json');
const root = await mkdtemp(path.join(os.tmpdir(), 'arkme-official-host-'));
await Promise.all(['home', 'workspace'].map(name => mkdir(path.join(root, name))));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const selected = server.address().port;
    server.close(error => error ? reject(error) : resolve(selected));
  });
});
const child = spawn(electron, [
  '--expose-internals', path.join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
  'web', '--no-open', '--host', '127.0.0.1', '--port', String(port),
], {
  cwd: path.join(root, 'workspace'), detached: process.platform !== 'win32',
  env: {
    ...process.env, DSH_HOME: path.join(root, 'dsh-home'), HOME: path.join(root, 'home'),
    ELECTRON_RUN_AS_NODE: '1', ARKME_NODE_EXEC_PATH: electron,
    ARKME_PNPM_CLI_PATH: path.join(runtime, 'node_modules/pnpm/bin/pnpm.cjs'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', value => { log += value; });
child.stderr.on('data', value => { log += value; });
const exited = new Promise(resolve => child.once('exit', resolve));
let spawnError;
child.once('error', error => { spawnError = error; });
const result = { scope: 'official-host-only', runtime, root, ready: false };
try {
  const deadline = Date.now() + 30_000;
  let cookie;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Official Host exited with code ${child.exitCode}`);
    try {
      const origin = `http://127.0.0.1:${port}`;
      // Official Web serves a launch token and exchanges it for an HttpOnly
      // session cookie. Keep both local; neither belongs in the result report.
      if (cookie === undefined) {
        const launch = log.match(new RegExp(`dsh web: (http://127\\.0\\.0\\.1:${port}/\\S+)`))?.[1];
        if (launch !== undefined && new URL(launch).origin === origin) {
          const response = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(500) });
          const cookies = response.headers.getSetCookie();
          cookie = cookies.map(value => value.split(';')[0]).join('; ');
          result.httpOnlySession = cookies.some(value => /;\s*HttpOnly/i.test(value));
        }
      }
      const response = await fetch(origin, {
        ...(cookie ? { headers: { Cookie: cookie } } : {}),
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        result.httpStatus = response.status;
        result.htmlBytes = (await response.text()).length;
        result.ready = true;
        break;
      }
    } catch { /* Retry only while the owned Host is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!result.ready) throw new Error('Official Host startup timed out');
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  if (child.pid && child.exitCode === null) {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null) {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
      await exited;
    }
  }
  await writeFile(path.join(root, 'harness.log'), log);
  await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
