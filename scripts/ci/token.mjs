// stdout is a private pipe carrying only the one-time value. Never log it.
import {generateKeyPairSync, privateDecrypt, constants} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {api} from './api.mjs';

const reasons = new Set(['device_unavailable', 'unlock_failed', 'account_mismatch', 'token_unreadable', 'codex_failed', 'timeout']);
const states = new Set(['pending', 'leased', 'ready', 'failed', 'expired', 'cancelled', 'consumed']);
const seconds = value => Number.isFinite(value) ? Math.trunc(value) : 0;

export async function requestSigningToken({reservation, attempt, invocationRunId, buildAttempt,
  apiCall = api, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  keyPair = () => generateKeyPairSync('rsa', {modulusLength: 3072}), diagnostic = () => {}}) {
  const {publicKey, privateKey} = keyPair();
  const identity = {batch_id: reservation.id, run_id: reservation.run_id};
  const started = now();
  let task, result, stage = 'create', reason = 'request_failed';
  try {
    task = await apiCall('signing/tasks/create', {...identity, attempt, invocation_run_id: invocationRunId,
      build_attempt: buildAttempt, public_key: publicKey.export({type: 'spki', format: 'pem'})});
    while (now() < task.deadline * 1000) {
      stage = 'result';
      result = await apiCall('signing/tasks/result', {...identity, task_id: task.id});
      if (['failed', 'expired', 'cancelled', 'consumed'].includes(result.status)) {
        reason = reasons.has(result.error) ? result.error : (result.status === 'failed' ? 'unknown' : result.status);
        throw new Error('Signing task unavailable');
      }
      if (result.status === 'ready') {
        stage = 'decrypt'; reason = 'invalid_token';
        const plain = privateDecrypt({key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256'},
          Buffer.from(result.ciphertext, 'base64'));
        let token;
        try { token = JSON.parse(plain.toString()); } finally { plain.fill(0); }
        stage = 'validate';
        if (token.task_id !== task.id || token.attempt !== attempt || token.expires_at < now() / 1000 + 15
          || token.expires_at !== result.expires_at || !/^\d{6}$/.test(token.token)) throw new Error('Invalid signing token');
        stage = 'ack'; reason = 'request_failed';
        await apiCall('signing/tasks/ack', {...identity, task_id: task.id});
        const value = token.token; token.token = '';
        return value;
      }
      await wait(1000);
    }
    stage = 'wait'; reason = 'timeout';
    throw new Error('Signing task timed out');
  } catch (error) {
    // Only fixed enums and numeric clock observations may cross the logging boundary.
    // Never include error messages, credentials, account/device IDs, keys or ciphertext.
    if (reason === 'request_failed') {
      const http = /^CI API HTTP ([1-5]\d{2})$/.exec(error?.message ?? '');
      if (http) reason = 'http_' + http[1];
      else if (error?.message === 'CI API connection unavailable') reason = 'connection_unavailable';
      else if (error?.message === 'CI API response unavailable') reason = 'response_unavailable';
      else if (error?.message === 'CI API rejected: client_ci_request_failed') reason = 'api_rejected';
    }
    const elapsed = Math.max(0, seconds(now() - started));
    const skew = task?.created_at ? seconds(now() / 1000 - task.created_at - elapsed / 1000) : 0;
    const ttl = result?.expires_at ? seconds(result.expires_at - now() / 1000) : 0;
    const status = states.has(result?.status) ? result.status : 'unknown';
    diagnostic(`Signing token unavailable: stage=${stage} reason=${reason} status=${status} elapsed_ms=${elapsed} clock_skew_s=${skew} ttl_s=${ttl}`);
    if (task) await apiCall('signing/tasks/cancel', {...identity, task_id: task.id}).catch(() => {});
    throw new Error('Signing token unavailable');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const reservation = JSON.parse(await readFile('reservation.json', 'utf8'));
    const value = await requestSigningToken({reservation, attempt: Number(process.argv[2] ?? 1),
      invocationRunId: process.env.GITHUB_RUN_ID, buildAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      diagnostic: line => process.stderr.write(line + '\n')});
    process.stdout.write(value);
  } catch { process.exitCode = 1; }
}
