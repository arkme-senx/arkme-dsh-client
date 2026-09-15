import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { HarnessProcessSupervisor } from '../src/harness-supervisor.js';
import { harnessCookieHeader, type HarnessAuthSession } from '../src/harness-auth-session.js';
import { provisionArkmeWebProfile } from '../src/plugin-profile.js';

const enabled = process.env.RUN_HARNESS_RC2_INTEGRATION === '1';

describe.skipIf(!enabled)('real packaged Harness rc2 supervisor integration', () => {
  test('authenticates a clean page, registers an isolated workspace, reads sessions, and serves the local plugin', async () => {
    const runtimeRoot = path.resolve(process.env.HARNESS_RC2_ROOT ?? '/tmp/arkme-rc2-artifact-probe/harness');
    const pluginSource = path.resolve(process.env.HARNESS_RC2_PLUGIN ?? '.runtime/dsh-arm64/node_modules/@senguoyun/dsh-arkme');
    const pluginDir = path.join(runtimeRoot, 'node_modules/@senguoyun/dsh-arkme');
    await cp(pluginSource, pluginDir, { recursive: true });
    const root = await mkdtemp(path.join(tmpdir(), 'arkme-real-rc2-supervisor-'));
    const workspace = path.join(root, 'workspace');
    const dshHome = path.join(root, 'dsh-home');
    const home = path.join(root, 'home');
    await Promise.all([mkdir(workspace), mkdir(home)]);
    await provisionArkmeWebProfile({ dshHome, pluginDir, dshVersion: '0.1.5-rc.2' });
    await writeFile(path.join(dshHome, 'profiles/web/cordis.patch.yml'), '- id: arkme-self\n  config:\n    updateCheckEnabled: false\n');
    const logPath = path.join(root, 'harness.log');
    let authenticated: HarnessAuthSession | undefined;
    const require = createRequire(import.meta.url);
    const supervisor = new HarnessProcessSupervisor({
      execPath: require('electron') as string,
      dshBinPath: path.join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      dshHome,
      logPath,
      packageManagerBinPath: path.join(runtimeRoot, 'node_modules/.bin'),
      packageManagerCliPath: path.join(runtimeRoot, 'node_modules/pnpm/bin/pnpm.cjs'),
      inheritedEnv: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: tmpdir(), LANG: 'en_US.UTF-8' },
      onAuthenticated: async session => { authenticated = session; }
    });
    try {
      await supervisor.start(workspace, { timeoutMs: 60_000, pollIntervalMs: 200 });
      const state = supervisor.getState();
      if (state?.kind !== 'ready') throw new Error(`Real rc2 supervisor failed: ${JSON.stringify(state)}\n${await readFile(logPath, 'utf8')}`);
      if (!authenticated) throw new Error('Supervisor did not provide its authenticated session');
      expect(new URL(state.url).search).toBe('');
      const cookie = harnessCookieHeader(authenticated);
      const page = await fetch(state.url, { headers: { cookie }, redirect: 'manual' });
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      await page.body?.cancel();
      const unauthorized = await fetch(state.url, { redirect: 'manual' });
      expect(unauthorized.status).toBe(401);
      await unauthorized.body?.cancel();
      const request = async (method: string, args: unknown, rpcId: string) => {
        const response = await fetch(new URL(`/api/${method}`, state.url), { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) });
        expect(response.status).toBe(200);
        return response.json();
      };
      const sessions = await request('session/list', { _request: {} }, 'rc2-sessions');
      expect(sessions).toMatchObject({ type: 'server-response', rpcId: 'rc2-sessions', result: { ok: true, value: { items: [] } } });
      const created = await request('workspace/create', { request: { path: workspace } }, 'rc2-workspace');
      expect(created).toMatchObject({ type: 'server-response', rpcId: 'rc2-workspace', result: { ok: true, value: { workspace: { path: await realpath(workspace) } } } });
      const health = await fetch(new URL('/arkme-self/api', state.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'provider.capabilities' }) });
      expect(health.status).toBe(200);
      const capabilities = await health.json();
      expect(capabilities).toMatchObject({ ok: true, value: { provider: '@senguoyun/dsh-arkme' } });
      const report = { runtimeVersion: '0.1.5-rc.2', authenticatedHomepage: true, unauthorizedHomepageRejected: true, sessionList: true, workspaceCreate: true, pluginHealth: true, isolatedRoot: root };
      await writeFile('/tmp/arkme-real-rc2-supervisor-report.json', JSON.stringify(report, null, 2));
    } finally {
      await supervisor.stop('quit');
    }
  }, 90_000);
});
