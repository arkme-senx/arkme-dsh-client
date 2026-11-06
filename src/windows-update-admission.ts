import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import type { PendingAppUpdateInstall } from './app-update.js';

const run = promisify(execFile);
const reasons = new Set([
  'eligible', 'registration-missing-or-ambiguous', 'recovery-required',
  'legacy-migration-required', 'legacy-identity', 'shortcut-migration-required', 'inspection-failed',
]);
export interface WindowsUpdateEligibility { eligible: boolean; reason: string }

/** Advisory only: the signed installer still performs the authoritative check. */
export async function inspectWindowsUpdateEligibility(options: {
  executablePath: string;
  scriptPath: string;
  target: PendingAppUpdateInstall;
}): Promise<WindowsUpdateEligibility> {
  const failed = { eligible: false, reason: 'inspection-failed' };
  if (win32.basename(options.executablePath).toLowerCase() !== 'arkme.exe') return failed;
  try {
    const shell = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await run(shell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', options.scriptPath, '-Action', 'InspectUpdate',
      '-Destination', win32.dirname(options.executablePath),
      '-UpdateVersion', options.target.version, '-UpdateVersionCode', String(options.target.versionCode),
    ], { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024, encoding: 'utf8' });
    const result: unknown = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
    if (result === null || typeof result !== 'object') return failed;
    const value = result as Record<string, unknown>;
    if (typeof value.eligible !== 'boolean' || typeof value.reason !== 'string' || !reasons.has(value.reason)
      || value.eligible !== (value.reason === 'eligible')) return failed;
    return { eligible: value.eligible, reason: value.reason };
  } catch {
    return failed;
  }
}
