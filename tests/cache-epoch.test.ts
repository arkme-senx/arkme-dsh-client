import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { readPreviousRuntimeBaseline } from '../src/runtime/cache-epoch.js';
import { createEmptyRuntimeState } from '../src/runtime/state.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {...actual, readFile: vi.fn(actual.readFile)};
});
const roots: string[] = [];
const context = {os:'darwin',arch:'arm64',shellVersion:'0.2.0',electronMajor:43,modulesAbi:148} as const;
afterEach(async () => { vi.mocked(readFile).mockClear(); await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))); });
async function legacy(state: string) {
  const userData = await mkdtemp(path.join(tmpdir(),'epoch-invalid-baseline-')); roots.push(userData);
  const root = path.join(userData,'runtime-manager','electron-v1'); await mkdir(root,{recursive:true});
  await writeFile(path.join(root,'state.json'),state);
  return {userData,root};
}

test.each(['{broken','null','[]',JSON.stringify({environment:'prod',schemaVersion:999})])('skips corrupt optional state metadata %s',async state => {
  const {userData}=await legacy(state);
  await expect(readPreviousRuntimeBaseline(userData,'prod',context)).resolves.toBeUndefined();
});

test.each([undefined,'{broken',JSON.stringify({schemaVersion:1,target:{os:'windows',arch:'x64'},electron:{major:42,modulesAbi:145},artifacts:{}})])('skips missing, malformed or incompatible old release metadata',async manifest => {
  const state = createEmptyRuntimeState('prod'); state.activeReleaseId='electron-runtime-v1-'+'a'.repeat(32);
  const {userData,root}=await legacy(JSON.stringify(state));
  if (manifest !== undefined) { const dir=path.join(root,'releases',state.activeReleaseId); await mkdir(dir,{recursive:true}); await writeFile(path.join(dir,'release.json'),manifest); }
  await expect(readPreviousRuntimeBaseline(userData,'prod',context)).resolves.toBeUndefined();
});

test.each(['EACCES','EIO'])('propagates actual storage failure %s',async code => {
  const {userData}=await legacy('{}');
  const failure=Object.assign(new Error('storage failure'),{code});
  vi.mocked(readFile).mockRejectedValueOnce(failure);
  await expect(readPreviousRuntimeBaseline(userData,'prod',context)).rejects.toBe(failure);
});
