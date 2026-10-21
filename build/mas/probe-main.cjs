// Headless architecture probe, not the Jiwo client or an App Store submission.
const { app } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const report = { purpose: 'MAS Harness spawn probe', mas: process.mas === true,
  arch: process.arch, electron: process.versions.electron, modules: process.versions.modules,
  startedAt: new Date().toISOString() };
function finish(code) {
  report.finishedAt = new Date().toISOString();
  console.log('MAS_PROBE_RESULT=' + JSON.stringify(report));
  app.exit(code);
}
app.whenReady().then(() => {
  if (!process.mas) throw new Error('MAS Electron required');
  const frozen = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'frozen.json'), 'utf8'));
  const manifest = frozen.manifests[process.arch];
  report.combinationSha256 = frozen.combinationSha256;
  report.releaseId = manifest.releaseId;
  const entry = path.join(process.resourcesPath, 'embedded', process.arch, manifest.artifacts.harness.entry);
  // Deliberately use the production supervisor's process.execPath / RUN_AS_NODE model.
  // --help validates loading/launch without starting the business plugin or touching user data.
  const child = spawn(process.execPath, ['--expose-internals', entry, '--help'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  report.stdout = ''; report.stderr = '';
  child.stdout.on('data', data => { report.stdout = (report.stdout + data).slice(-16000); });
  child.stderr.on('data', data => { report.stderr = (report.stderr + data).slice(-16000); });
  const timeout = setTimeout(() => { report.timeout = true; child.kill('SIGKILL'); }, 30000);
  child.on('error', error => { report.spawnError = error.message; });
  child.on('close', (code, signal) => {
    clearTimeout(timeout); report.exitCode = code; report.signal = signal;
    finish(code === 0 ? 0 : 1);
  });
}).catch(error => { report.error = error.stack; finish(1); });
