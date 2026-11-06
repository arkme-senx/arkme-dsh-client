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

describe.skipIf(process.platform !== 'darwin')('migration PKG preflight ticket validation', () => {
  async function preflight(ticketError: string) {
    const { buildMigrationPackage } = await import('../scripts/build-macos-migration.mjs');
    const manifest = require('../package.json');
    let tickets = 0;
    const spawn = vi.spyOn(childProcess, 'spawnSync').mockImplementation(((tool: string, args: string[]) => {
      let status = 0, stdout = '', stderr = '';
      const command = tool.split('/').at(-1);
      if (command === 'plutil') stdout = JSON.stringify({ CFBundleIdentifier: manifest.build.mac.appId, CFBundleName: '即我',
        CFBundleExecutable: 'arkme', CFBundleShortVersionString: manifest.version, CFBundleVersion: String(manifest.versionCode),
        LSMinimumSystemVersion: manifest.build.mac.minimumSystemVersion });
      else if (command === 'codesign' && args[0] === '-dv') stdout = 'TeamIdentifier=ABCDE12345\nAuthority=Developer ID Application: Fixture (ABCDE12345)\n';
      else if (command === 'xcrun' && args[0] === 'stapler' && args[1] === 'validate') {
        if (tickets++ === 0) { status = 68; stdout = ticketError; stderr = 'Additional ticket diagnostic'; }
      } else if (command === 'spctl') { status = 1; stderr = 'Gatekeeper fixture rejection'; }
      else if (command !== 'codesign' && command !== 'lipo') throw new Error(`Unexpected fixture command: ${command}`);
      return { pid: 1, status, signal: null, stdout, stderr, output: [null, stdout, stderr] };
    }) as typeof childProcess.spawnSync);
    const operation = buildMigrationPackage({ appRoot: '/signed/即我.app', outputDirectory: '/unused', env: {
      CSC_NAME: 'Developer ID Application: Fixture (ABCDE12345)', JIWO_INSTALLER_IDENTITY: 'Developer ID Installer: Fixture (ABCDE12345)',
      JIWO_NOTARY_PROFILE: 'fixture-profile'
    } });
    return { operation, spawn, ticketCount: () => tickets };
  }

  it('recovers a preflight connection loss while still enforcing the following Gatekeeper check', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fixture = await preflight('Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."');
    await expect(fixture.operation).rejects.toThrow('Gatekeeper fixture rejection');
    expect(fixture.ticketCount()).toBe(2);
    expect(fixture.spawn.mock.calls.some(call => String(call[0]).endsWith('/spctl'))).toBe(true);
  });

  it('retains stdout diagnostics and rejects an invalid ticket without retrying or reaching packaging', async () => {
    const fixture = await preflight('Invalid notarization ticket');
    await expect(fixture.operation).rejects.toThrow('Invalid notarization ticket');
    expect(fixture.ticketCount()).toBe(1);
    expect(fixture.spawn.mock.calls.some(call => String(call[0]).endsWith('/spctl'))).toBe(false);
  });
});
