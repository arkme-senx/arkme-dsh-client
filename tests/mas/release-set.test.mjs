import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { freezeReleaseSet, assertPair } from '../../scripts/mas/release-set.mjs';
const manifest = arch => ({ target: { os: 'darwin', arch }, releaseId: `release-${arch}`,
  runtimeApiVersion: 1, dataSchemaVersion: 1, pnpmVersion: '11.19.0',
  artifacts: { harness: { version: '0.1.5', versionCode: 5 }, requiredPlugin: { version: '3.0.10', versionCode: 287 } },
  compatibility: { clientRuleRevision: 1, pluginRuleRevision: 2 } });
const channel = { version: '3.0.10', versionCode: 288 };
async function temp(fn) { const directory = await mkdtemp(path.join(os.tmpdir(), 'mas-freeze-')); try { await fn(directory); } finally { await rm(directory, {recursive:true,force:true}); } }
test('architecture-specific IDs are allowed; component skew and changing rules are rejected', () => {
  const pair = { arm64: manifest('arm64'), x64: manifest('x64') };
  assert.doesNotThrow(() => assertPair(pair));
  pair.x64.artifacts.harness.versionCode++;
  assert.throws(() => assertPair(pair), /pairing mismatch/);
  pair.x64 = manifest('x64'); pair.x64.compatibility.clientRuleRevision++;
  assert.throws(() => assertPair(pair), /changed during resolution/);
});
test('retry and promotion use frozen manifests without querying latest', () => temp(async directory => {
  let calls = 0;
  const options = { directory, channel, fetchManifest: async arch => { calls++; return manifest(arch); }, parseManifest: () => {} };
  const first = await freezeReleaseSet(options);
  const second = await freezeReleaseSet({ ...options, fetchManifest: () => { throw new Error('remote changed'); } });
  assert.equal(calls, 2); assert.deepEqual(first, second);
  await assert.rejects(freezeReleaseSet({...options, fresh: true}), /new --build-id/);
}));
test('failed second architecture cannot leave an authoritative partial freeze', () => temp(async directory => {
  await assert.rejects(freezeReleaseSet({directory,channel,parseManifest:()=>{},fetchManifest:async arch=> {
    if (arch === 'x64') throw new Error('unavailable'); return manifest(arch);
  }}), /unavailable/);
  await assert.rejects(readFile(path.join(directory,'frozen.json')), {code:'ENOENT'});
}));
test('tampered freeze and different channel/build number fail closed', () => temp(async directory => {
  const options = {directory,channel,parseManifest:()=>{},fetchManifest:async arch=>manifest(arch)};
  await freezeReleaseSet(options);
  await assert.rejects(freezeReleaseSet({...options,channel:{...channel,versionCode:289}}), /identity is invalid/);
  const file=path.join(directory,'frozen.json'); const frozen=JSON.parse(await readFile(file,'utf8'));
  frozen.manifests.arm64.artifacts.harness.versionCode++;
  await writeFile(file,JSON.stringify(frozen));
  await assert.rejects(freezeReleaseSet(options), /identity is invalid/);
}));
