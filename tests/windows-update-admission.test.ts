import { expect, test, vi } from 'vitest';
const mock = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mock.execFile }));
import { inspectWindowsUpdateEligibility } from '../src/windows-update-admission.js';
const options = {
  executablePath: 'C:\\Program Files\\即我\\arkme.exe',
  scriptPath: 'C:\\Program Files\\即我\\resources\\app.asar.unpacked\\dist\\windows-update-admission.ps1',
  target: { version: '3.0.26', versionCode: 304 },
};
function output(stdout: string, error: Error | null = null) {
  mock.execFile.mockImplementation((_exe, _args, _options, callback) => callback(error, { stdout, stderr: '' }));
}
test('uses the system PowerShell with separate arguments and a bounded hidden read-only action', async () => {
  output('{"eligible":true,"reason":"eligible"}');
  await expect(inspectWindowsUpdateEligibility(options)).resolves.toEqual({ eligible: true, reason: 'eligible' });
  const [exe, args, runOptions] = mock.execFile.mock.calls.at(-1)!;
  expect(exe).toMatch(/Windows[\\/]System32[\\/]WindowsPowerShell[\\/]v1.0[\\/]powershell.exe$/i);
  expect(args).toContain('InspectUpdate');
  expect(args).toContain('C:\\Program Files\\即我');
  expect(args).toContain(options.scriptPath);
  expect(runOptions).toMatchObject({ windowsHide: true, timeout: 20_000 });
});
test.each(['', '{', '{"eligible":"true","reason":"eligible"}', '{"eligible":true,"reason":"inspection-failed"}'])('fails closed on invalid helper output %s', async text => {
  output(text);
  await expect(inspectWindowsUpdateEligibility(options)).resolves.toEqual({ eligible: false, reason: 'inspection-failed' });
});
test('retains specific manual-install reason and handles helper execution failure', async () => {
  output('{"eligible":false,"reason":"legacy-identity"}');
  await expect(inspectWindowsUpdateEligibility(options)).resolves.toEqual({ eligible: false, reason: 'legacy-identity' });
  output('', new Error('timeout'));
  await expect(inspectWindowsUpdateEligibility(options)).resolves.toEqual({ eligible: false, reason: 'inspection-failed' });
});
