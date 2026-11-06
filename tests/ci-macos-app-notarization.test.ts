import {createRequire} from 'node:module';
import childProcess from 'node:child_process';
import {access, readFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {afterEach, expect, test, vi} from 'vitest';

const require = createRequire(import.meta.url);
const notarize = require('../scripts/ci/notarize-macos-app.cjs');
const env = {ARKME_CI_ENV: 'prod', APPLE_ID: 'fixture@example.test',
  APPLE_APP_SPECIFIC_PASSWORD: 'fixture-apple-password', APPLE_TEAM_ID: 'ABCDE12345'};
const context = {electronPlatformName: 'darwin', appOutDir: '/signed-universal',
  packager: {appInfo: {productFilename: '即我'}}};
const network = 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."';

afterEach(() => vi.restoreAllMocks());

function commands({status = 'Accepted', disconnect = false, invalid = false, submissionFailure = false} = {}) {
  let staples = 0, validations = 0, archive = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const spawn = vi.spyOn(childProcess, 'spawnSync').mockImplementation(((tool: string, args: string[]) => {
    let stdout = '', stderr = '', exit = 0;
    if (tool === 'ditto') archive = args.at(-1)!;
    else if (tool === 'codesign') expect(args).toEqual(['--verify', '--deep', '--strict', '/signed-universal/即我.app']);
    else if (tool === 'xcrun' && args[0] === 'notarytool') {
      stdout = JSON.stringify({status});
      if (submissionFailure) {exit = 1; stderr = 'Rejected fixture-apple-password';}
    } else if (tool === 'xcrun' && args[0] === 'stapler') {
      const attempt = args[1] === 'staple' ? staples++ : validations++;
      if (invalid) {exit = 68; stdout = 'Invalid notarization ticket';}
      else if (disconnect && attempt === 0) {exit = 68; stdout = network; stderr = 'Additional diagnostic';}
    } else throw new Error(`Unexpected fixture command: ${tool}`);
    return {pid: 1, status: exit, signal: null, stdout, stderr, output: [null, stdout, stderr]};
  }) as typeof childProcess.spawnSync);
  return {spawn, counts: () => ({staples, validations}), archive: () => archive};
}

test('formal CI requires the notarization hook before packaging and retains signing protections', async () => {
  const source = await readFile('electron-builder.ci-config.cjs', 'utf8');
  const module = {exports: {} as any};
  vm.runInNewContext(source, {module, process: {platform: 'darwin', env: {...env, ARKME_CDN_BASE: 'https://cdn.example.test'}},
    require: (name: string) => name === './reservation.json' ? {version: '3.0.28', version_code: 306}
      : require(path.resolve(name))});
  expect(module.exports.afterSign).toBe(notarize);
  expect(module.exports.mac).toMatchObject({notarize: false, forceCodeSigning: true, hardenedRuntime: true});
});

test('submits once and recovers staple/validate network loss on the same signed app before returning', async () => {
  const fixture = commands({disconnect: true});
  await notarize(context, {env});
  expect(fixture.counts()).toEqual({staples: 2, validations: 2});
  const submitted = fixture.spawn.mock.calls.filter(call => call[0] === 'xcrun' && call[1]?.[0] === 'notarytool');
  expect(submitted).toHaveLength(1);
  expect(submitted[0][1]).toEqual(['notarytool', 'submit', fixture.archive(), '--apple-id', env.APPLE_ID,
    '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID,
    '--wait', '--timeout', '20m', '--output-format', 'json']);
  expect(fixture.spawn.mock.calls.filter(call => call[0] === 'codesign')).toHaveLength(2);
  await expect(access(path.dirname(fixture.archive()))).rejects.toThrow(/ENOENT/);
});

test('rejected notarization cannot reach stapling or complete the packaging hook', async () => {
  const fixture = commands({status: 'Invalid'});
  await expect(notarize(context, {env})).rejects.toThrow('Application notarization was not accepted');
  expect(fixture.counts()).toEqual({staples: 0, validations: 0});
  await expect(access(path.dirname(fixture.archive()))).rejects.toThrow(/ENOENT/);
});

test('invalid tickets fail immediately even after Accepted', async () => {
  const fixture = commands({invalid: true});
  await expect(notarize(context, {env})).rejects.toThrow('Invalid notarization ticket');
  expect(fixture.counts()).toEqual({staples: 1, validations: 0});
});

test('submission failures remain fatal and redact account secrets', async () => {
  const fixture = commands({submissionFailure: true});
  const error = await notarize(context, {env}).catch((error: Error) => error);
  expect(error.message).toContain('[REDACTED]');
  expect(error.message).not.toContain(env.APPLE_APP_SPECIFIC_PASSWORD);
  expect(fixture.counts()).toEqual({staples: 0, validations: 0});
});

test('the shared hook leaves Windows packaging alone', async () => {
  const spawn = vi.spyOn(childProcess, 'spawnSync');
  await notarize({...context, electronPlatformName: 'win32'}, {env: {}});
  expect(spawn).not.toHaveBeenCalled();
});
