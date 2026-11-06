// Opt-in live-signed Windows verification. Only random fixture registry keys/files are written.
// No installer, application shutdown, telemetry or public update endpoint is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { inspectWindowsUpdateEligibility } from '../../dist/windows-update-admission.js';
import { ArkmeAppUpdateController } from '../../dist/app-update.js';

assert.equal(process.platform, 'win32');
const modern = process.env.ARKME_TEST_MODERN_EXE;
const legacy = process.env.ARKME_TEST_LEGACY_EXE;
assert.ok(modern && legacy, 'Explicit real signed fixture executables required');
const helper = path.resolve('dist/windows-update-admission.ps1');
const root = path.resolve('verification-' + randomUUID()); mkdirSync(root);
const executablePath = path.join(root, 'app', 'arkme.exe');
const key = 'Software\\ArkmeAdmissionProbe\\' + randomUUID();
const scriptPath = path.join(root, 'inspect.ps1');
let source = readFileSync(helper, 'utf8');
assert.match(source, /^\$ElectronKeys = .*$/m);
source = source.replace(/^\$ElectronKeys = .*$/m, () => `$ElectronKeys = @('${key}\\Install','${key}\\Uninstall','${key}\\Protocol')`);
const anchor = "if ($Action -eq 'Library') { return }";
assert.ok(source.includes(anchor));
// The copied PE has no installed shortcuts; the separate PowerShell suite covers shortcut rejection.
source = source.replace(anchor, `function Get-ShortcutLocations { return @() }\n${anchor}`);
writeFileSync(scriptPath, source);
const quote = s => "'" + s.replaceAll("'", "''") + "'";
const ps = s => execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
  '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';" + s, 'utf16le').toString('base64'),
], { encoding: 'utf8', windowsHide: true });
function setup(file, registered = true) {
  ps(`$null=New-Item -ItemType Directory ${quote(path.dirname(executablePath))} -Force; Copy-Item -LiteralPath ${quote(file)} -Destination ${quote(executablePath)} -Force;
  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${quote(key)},$false);
  ${registered ? `$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(key + '\\Install')}); $k.SetValue('InstallLocation',${quote(path.dirname(executablePath))});$k.SetValue('ShortcutName',[string]([char]0x5373)+[char]0x6211);$k.SetValue('MenuDirectory','');$k.Dispose();
  $k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(key + '\\Uninstall')});$k.SetValue('DisplayVersion','3.0.23');$k.SetValue('JiwoVersionCode',301,[Microsoft.Win32.RegistryValueKind]::DWord);$k.Dispose();` : ''}`);
}
const target = { version: '3.0.26', versionCode: 304 };
const inspect = () => inspectWindowsUpdateEligibility({ executablePath, scriptPath, target });
function controller() {
  const calls = { exit: 0, launch: 0, download: 0 };
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: target.version, files: [
      { url: 'arkme-3.0.26-vc304-x64.exe', sha512: Buffer.alloc(64, 1).toString('base64'), size: 100 },
    ] } }),
    downloadUpdate: async () => { calls.download++; return ['fixture-update.exe']; },
    quitAndInstall: () => { calls.launch++; },
  });
  const c = new ArkmeAppUpdateController({
    currentVersion: '3.0.23', currentVersionCode: 301, platform: 'win32', arch: 'x64',
    serviceBaseUrl: 'https://api.example.test',
    fetchImpl: async () => new Response(JSON.stringify({ ...target, updateFeedUrl: 'https://updates.example.test/' })),
    createUpdater: () => updater,
    checkInstallEligibility: async () => (await inspect()).eligible,
    installUpdate: async (_target, launch) => { calls.exit++; launch(); },
  });
  return { c, calls };
}
try {
  const live = await inspectWindowsUpdateEligibility({ executablePath: modern, scriptPath: helper, target });
  assert.equal(live.eligible, true, 'Current real installation must remain eligible');
  console.log('real registered modern installation: eligible');
  for (const [name, file, registered, reason] of [
    ['missing-registration', modern, false, 'registration-missing-or-ambiguous'],
    ['legacy-identity', legacy, true, 'legacy-identity'],
  ]) {
    setup(file, registered);
    assert.deepEqual(await inspect(), { eligible: false, reason });
    const f = controller(); const state = await f.c.prepareNow();
    assert.equal(state.status, 'available'); assert.equal(state.canAutoInstall, false); assert.match(state.error, /完整安装包/);
    assert.deepEqual(f.calls, { exit: 0, launch: 0, download: 0 });
    console.log(name + ': manual installer offered; download=0 exit=0 launch=0');
  }
  setup(modern);
  const f = controller(); assert.equal((await f.c.prepareNow()).status, 'downloaded');
  setup(modern, false);
  assert.equal((await f.c.install()).canAutoInstall, false);
  assert.deepEqual(f.calls, { exit: 0, launch: 0, download: 1 });
  console.log('registration lost after download: exit=0 launch=0');
  setup(modern);
  const healthy = controller(); await healthy.c.prepareNow();
  assert.equal((await healthy.c.install()).status, 'installing');
  assert.deepEqual(healthy.calls, { exit: 1, launch: 1, download: 1 });
  console.log('healthy registered update: download/exit/launch spies each 1 (no real install)');
  const journal = path.join(path.dirname(executablePath), '.jiwo-v3-transaction'); mkdirSync(journal);
  const record = path.join(journal, 'journal.json'); writeFileSync(record, 'must remain unchanged');
  const before = createHash('sha256').update(readFileSync(record)).digest('hex');
  assert.deepEqual(await inspect(), { eligible: false, reason: 'recovery-required' });
  assert.equal(createHash('sha256').update(readFileSync(record)).digest('hex'), before);
  console.log('recovery record: refused without mutation');
  const failed = await inspectWindowsUpdateEligibility({ executablePath, scriptPath: path.join(root, 'missing.ps1'), target });
  assert.equal(failed.eligible, false);
  console.log('missing helper: fails closed');
  console.log('Windows live-signed update eligibility/controller integration passed');
} finally {
  ps(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${quote(key)},$false)`);
}
