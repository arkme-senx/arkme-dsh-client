import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const [application, reportFile, architecture = 'arm64'] = process.argv.slice(2);
if (!application || !reportFile || !['arm64', 'x86_64'].includes(architecture))
  throw new Error('Usage: run-probe.mjs <verified-app> <report.json> [arm64|x86_64]');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = { application: path.resolve(application), architecture, startedAt: new Date().toISOString(),
  scope: 'Harness --help only; no business plugin or installer', stdout: '', stderr: '' };
const child = spawn('/usr/bin/arch', [`-${architecture}`, path.resolve(application, 'Contents/MacOS/arkme')], {
  env, detached: true, stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', data => { result.stdout = (result.stdout + data).slice(-64000); });
child.stderr.on('data', data => { result.stderr = (result.stderr + data).slice(-64000); });
child.on('error', error => { result.error = error.message; });
const timeout = setTimeout(() => {
  result.timeout = true;
  if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}, 45000);
await new Promise(resolve => child.on('close', (code, signal) => { result.exitCode=code; result.signal=signal; resolve(); }));
clearTimeout(timeout);
result.finishedAt = new Date().toISOString();
const line = result.stdout.split('\n').find(value => value.startsWith('MAS_PROBE_RESULT='));
if (line) result.probe = JSON.parse(line.slice('MAS_PROBE_RESULT='.length));
await writeFile(reportFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.exitCode === 0 && result.probe?.mas === true && result.probe?.exitCode === 0 ? 0 : 1;
