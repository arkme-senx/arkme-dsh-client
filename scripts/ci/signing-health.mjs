import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function clockObservation(now, serverDate) {
  const server = Date.parse(serverDate);
  return {utc: new Date(now).toISOString(), http_date_skew_s: Number.isFinite(server) ? Math.round((now - server) / 1000) : null};
}

async function clock() {
  const base = new URL(process.env.ARKME_CI_BACKEND);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid clock diagnostic origin');
  const response = await fetch(new URL('/api/public/v1/arkme/app-update/darwin/arm64/latest', base), {signal: AbortSignal.timeout(15_000), cache: 'no-store'});
  const observation = clockObservation(Date.now(), response.headers.get('date'));
  await response.body?.cancel();
  console.log('Signing clock diagnostic ' + JSON.stringify({...observation, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, http_status: response.status}));
}

export function timestampObservation(status, text) {
  const granted = /^Status: Granted(?: with mods)?\./m.test(text);
  const match = text.match(/^Time stamp:\s*(.+)$/m);
  const epoch = match ? Date.parse(match[1]) : NaN;
  return {http_status: Number(status) || 0, timestamp_status: granted ? 'granted' : 'unavailable',
    timestamp_utc: Number.isFinite(epoch) ? new Date(epoch).toISOString() : null};
}

async function timestamp() {
  const directory = await mkdtemp(path.join(tmpdir(), 'arkme-timestamp-health-'));
  try {
    const query = path.join(directory, 'query.tsq'), reply = path.join(directory, 'reply.tsr');
    const options = {encoding: 'utf8', timeout: 25_000, maxBuffer: 1024 * 1024};
    const request = spawnSync('openssl', ['ts', '-query', '-digest', '0'.repeat(64), '-sha256', '-cert', '-out', query], options);
    if (request.status !== 0) throw new Error('Timestamp probe query unavailable');
    // Probe the same Apple service used by codesign. This does not replace its trust verification.
    const result = spawnSync('curl', ['--silent', '--show-error', '--max-time', '20', '--max-filesize', '1048576',
      '--header', 'Content-Type: application/timestamp-query', '--data-binary', '@' + query,
      '--output', reply, '--write-out', '%{http_code}', 'http://timestamp.apple.com/ts01'], options);
    const parsed = result.status === 0 ? spawnSync('openssl', ['ts', '-reply', '-in', reply, '-text'], options) : null;
    const observation = timestampObservation(result.stdout, parsed?.status === 0 ? parsed.stdout : '');
    const bytes = await readFile(reply).then(value => value.length, () => 0);
    console.log('Apple timestamp diagnostic ' + JSON.stringify({...observation, utc: new Date().toISOString(), curl_exit: result.status, response_bytes: bytes}));
    if (result.status !== 0 || observation.http_status !== 200 || observation.timestamp_status !== 'granted') process.exitCode = 1;
  } finally { await rm(directory, {recursive: true, force: true}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2];
  (action === 'clock' ? clock() : action === 'timestamp' ? timestamp() : Promise.reject(new Error('Unknown signing diagnostic')))
    .catch(() => { console.error('Signing health diagnostic unavailable'); process.exitCode = 1; });
}
