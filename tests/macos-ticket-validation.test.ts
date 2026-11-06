import { createRequire } from 'node:module';
import childProcess from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { validateMacNotarizationTicket } = require('../scripts/macos-ci-signing.cjs');
const interrupted = () => new Error('xcrun failed (68): Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."');

afterEach(() => vi.restoreAllMocks());

describe('Apple notarization ticket validation', () => {
  it('recognizes a connection loss captured from the real command adapter', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let attempt = 0;
    const spawn = vi.spyOn(childProcess, 'spawnSync').mockImplementation((() => {
      const failed = attempt++ === 0;
      const stdout = failed ? '' : 'The validate action worked!\n';
      const stderr = failed ? 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."' : '';
      return { pid: 1, status: failed ? 68 : 0, signal: null, stdout, stderr, output: [null, stdout, stderr] };
    }) as typeof childProcess.spawnSync);
    const wait = vi.fn();
    validateMacNotarizationTicket('/signed/app.pkg', {}, { wait });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls.every(call => call[0] === 'xcrun' && JSON.stringify(call[1]) === JSON.stringify(['stapler', 'validate', '/signed/app.pkg']))).toBe(true);
    expect(wait).toHaveBeenCalledWith(1000);
  });

  it('requires successful stapler validation of the same signed artifact after connection losses', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const env = {}, run = vi.fn().mockImplementationOnce(() => { throw interrupted(); })
      .mockImplementationOnce(() => { throw interrupted(); }).mockReturnValue('');
    const wait = vi.fn();
    validateMacNotarizationTicket('/signed/即我.app', env, { run, wait });
    expect(run.mock.calls).toEqual(Array.from({ length: 3 }, () => ['xcrun', ['stapler', 'validate', '/signed/即我.app'], env, true]));
    expect(wait.mock.calls).toEqual([[1000], [2000]]);
  });

  it.each(['xcrun failed (68): Ticket is invalid', 'codesign failed (1): invalid signature', 'xcrun failed (69): authentication rejected'])(
    'fails immediately for non-transient validation errors: %s', message => {
      const error = new Error(message), run = vi.fn(() => { throw error; }), wait = vi.fn();
      expect(() => validateMacNotarizationTicket('/signed/app.pkg', {}, { run, wait })).toThrow(error);
      expect(run).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
    });

  it('fails after three connection losses instead of accepting an unverified artifact', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const error = interrupted(), run = vi.fn(() => { throw error; }), wait = vi.fn();
    expect(() => validateMacNotarizationTicket('/signed/app.pkg', {}, { run, wait })).toThrow(error);
    expect(run).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('does not retry a successful validation and redacts its logged output', () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const run = vi.fn(() => 'Validated for ci-secret@example.test\n'), wait = vi.fn();
    validateMacNotarizationTicket('/signed/app.pkg', { APPLE_ID: 'ci-secret@example.test' }, { run, wait });
    expect(run).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith('Validated for [REDACTED]\n');
  });
});
