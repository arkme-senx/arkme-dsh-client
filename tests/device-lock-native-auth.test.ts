import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
import { runDeviceAuthentication } from '../src/device-lock-native-auth.js';

function helper() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
  mocked.spawn.mockReturnValue(child);
  return child;
}
function result(outcome = 'authenticated') {
  return JSON.stringify({ schemaVersion: 1, platform: process.platform, outcome });
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('waits for the final stdout chunk after exit before accepting authentication', async () => {
  const child = helper();
  const completed = vi.fn();
  const pending = runDeviceAuthentication('/fixture with spaces/helper', '--authenticate').then(completed);
  child.emit('exit', 0);
  await Promise.resolve(); expect(completed).not.toHaveBeenCalled();
  child.stdout.write(result()); child.emit('close', 0);
  await pending; expect(completed).toHaveBeenCalledWith(true);
  expect(mocked.spawn).toHaveBeenCalledWith('/fixture with spaces/helper', ['--authenticate'], expect.objectContaining({ shell: false }));
});
it('rejects cancellation, invalid output and nonzero exit even with an authenticated payload', async () => {
  for (const [output, code] of [[result('cancelled'), 0], ['broken', 0], [result(), 1]] as const) {
    const child = helper(); const pending = runDeviceAuthentication('/fixture/helper', '--authenticate');
    child.stdout.write(output); child.emit('close', code); expect(await pending).toBe(false);
  }
});
it('bounds output and prevents late success after cancellation', async () => {
  const child = helper(); const pending = runDeviceAuthentication('/fixture/helper', '--authenticate');
  child.stdout.write('x'.repeat(4097)); expect(await pending).toBe(false); expect(child.kill).toHaveBeenCalledOnce();
  child.stdout.write(result()); child.emit('close', 0);
  const next = helper(); const signal = new AbortController();
  const cancelled = runDeviceAuthentication('/fixture/helper', '--authenticate', signal.signal);
  signal.abort(); expect(await cancelled).toBe(false); expect(next.kill).toHaveBeenCalledOnce();
});
it('times out checks and authentication independently and releases failed spawns', async () => {
  vi.useFakeTimers();
  for (const [mode, timeout] of [['--check', 10000], ['--authenticate', 120000]] as const) {
    const child = helper(); const pending = runDeviceAuthentication('/fixture/helper', mode);
    await vi.advanceTimersByTimeAsync(timeout); expect(await pending).toBe(false); expect(child.kill).toHaveBeenCalledOnce();
  }
  const child = helper(); const pending = runDeviceAuthentication('/fixture/helper', '--check');
  child.emit('error', new Error('missing helper')); expect(await pending).toBe(false); expect(vi.getTimerCount()).toBe(0);
});
