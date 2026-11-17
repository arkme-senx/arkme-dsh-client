import {generateKeyPairSync, publicEncrypt, constants} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {describe, it, expect, vi} from 'vitest';
import {requestSigningToken} from '../scripts/ci/token.mjs';
import {clockObservation, timestampObservation} from '../scripts/ci/signing-health.mjs';

const keys = generateKeyPairSync('rsa', {modulusLength: 3072});
const epoch = Date.parse('2026-11-17T18:00:00Z');
const task = {id: 'task', created_at: epoch / 1000, deadline: epoch / 1000 + 180};
const options = {reservation: {id: 'batch', run_id: 'run'}, attempt: 1, invocationRunId: 'run', buildAttempt: 3,
  now: () => epoch, keyPair: () => keys, wait: async () => {}};
const ready = (expires = epoch / 1000 + 30) => ({status: 'ready', expires_at: expires, ciphertext: publicEncrypt(
  {key: keys.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256'},
  Buffer.from(JSON.stringify({task_id: task.id, attempt: 1, expires_at: expires, token: '123456'}))).toString('base64')});

describe('CI signing private pipe', () => {
  it('acknowledges a valid encrypted token and returns it without logging', async () => {
    const diagnostic = vi.fn(), calls = [];
    const apiCall = async (route, body) => { calls.push({route, body}); return route.endsWith('/create') ? task : route.endsWith('/result') ? ready() : {}; };
    expect(await requestSigningToken({...options, apiCall, diagnostic})).toBe('123456');
    expect(calls.map(c => c.route)).toEqual(['signing/tasks/create', 'signing/tasks/result', 'signing/tasks/ack']);
    expect(calls[0].body).toMatchObject({build_attempt: 3, invocation_run_id: 'run'});
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it.each(['device_unavailable', 'unlock_failed', 'account_mismatch', 'token_unreadable', 'codex_failed', 'timeout'])('reports only the allowlisted worker reason %s', async error => {
    const diagnostic = vi.fn(), apiCall = vi.fn(async route => route.endsWith('/create') ? task : {status: 'failed', error});
    await expect(requestSigningToken({...options, apiCall, diagnostic})).rejects.toThrow('Signing token unavailable');
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(`Signing token unavailable: stage=result reason=${error} status=failed elapsed_ms=0 clock_skew_s=0 ttl_s=0`);
    expect(apiCall).toHaveBeenLastCalledWith('signing/tasks/cancel', {batch_id: 'batch', run_id: 'run', task_id: 'task'});
  });

  it('never copies API errors or arbitrary worker text into diagnostics', async () => {
    for (const failure of [new Error('secret=123456 https://credentials.example'), {status: 'failed', error: 'private-account 123456'}]) {
      const lines = [];
      const apiCall = async route => {if (route.endsWith('/create')) return task; if (failure instanceof Error) throw failure; return failure;};
      await expect(requestSigningToken({...options, apiCall, diagnostic: line => lines.push(line)})).rejects.toThrow('Signing token unavailable');
      expect(lines.join('')).not.toMatch(/123456|credentials|private-account|https/);
    }
  });

  it.each([
    ['CI API HTTP 401', 'http_401'], ['CI API HTTP 503', 'http_503'],
    ['CI API connection unavailable', 'connection_unavailable'],
    ['CI API rejected: client_ci_request_failed', 'api_rejected'],
  ])('classifies %s without including a raw error', async (message, reason) => {
    const diagnostic = vi.fn();
    await expect(requestSigningToken({...options, diagnostic, apiCall: async () => {throw new Error(message);}})).rejects.toThrow('Signing token unavailable');
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining(`stage=create reason=${reason} status=unknown`));
  });

  it('rejects an expiring token before acknowledgement and reports its remaining UTC lifetime', async () => {
    const diagnostic = vi.fn(), apiCall = vi.fn(async route => route.endsWith('/create') ? task : ready(epoch / 1000 + 14));
    await expect(requestSigningToken({...options, apiCall, diagnostic})).rejects.toThrow('Signing token unavailable');
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('stage=validate reason=invalid_token status=ready elapsed_ms=0 clock_skew_s=0 ttl_s=14'));
    expect(apiCall.mock.calls.some(([route]) => route.endsWith('/ack'))).toBe(false);
  });

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Shanghai'])('uses the same Unix time in %s', zone => {
    const source = `import {clockObservation} from './scripts/ci/signing-health.mjs'; console.log(JSON.stringify(clockObservation(${epoch}, 'Tue, 17 Nov 2026 18:00:00 GMT')))`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {encoding: 'utf8', env: {...process.env, TZ: zone}});
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({utc: '2026-11-17T18:00:00.000Z', http_date_skew_s: 0});
  });

  it('does not mistake a proxy error or a rejected timestamp for success', () => {
    expect(timestampObservation('502', '<html>proxy error</html>')).toMatchObject({http_status: 502, timestamp_status: 'unavailable'});
    expect(timestampObservation('200', 'Status: Rejected.')).toMatchObject({timestamp_status: 'unavailable'});
    expect(timestampObservation('200', 'Status: Granted.\nTime stamp: Nov 17 18:00:00 2026 GMT\n')).toMatchObject({timestamp_status: 'granted', timestamp_utc: '2026-11-17T18:00:00.000Z'});
    expect(clockObservation(epoch, undefined).http_date_skew_s).toBe(null);
  });
});
