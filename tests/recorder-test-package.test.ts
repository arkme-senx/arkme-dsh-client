import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readPackagedTestPluginPath,packagedArkmePluginPath} from '../src/runtime-path.js';
import {resolveUserDataPath} from '../src/settings.js';
import {pluginHostEnvironment} from '../src/plugin-host-policy.js';

describe('portable recorder test packages',()=>{
 it('resolves the plugin inside the installed app, without a build-machine path',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'recorder-package-'));
  try {
   await writeFile(path.join(root,'ARKME_TEST_PLUGIN.json'),JSON.stringify({schemaVersion:1,source:'bundled',packageName:'@senguoyun/dsh-arkme'}));
   expect(await readPackagedTestPluginPath(root)).toBe(packagedArkmePluginPath(root));
  } finally {await rm(root,{recursive:true,force:true});}
 });
 it('rejects an ambiguous bundled marker containing an arbitrary external plugin path',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'recorder-package-'));
  try {
   await writeFile(path.join(root,'ARKME_TEST_PLUGIN.json'),JSON.stringify({schemaVersion:1,source:'bundled',packageName:'@senguoyun/dsh-arkme',pluginPath:'/another/plugin'}));
   await expect(readPackagedTestPluginPath(root)).rejects.toThrow('Invalid');
  } finally {await rm(root,{recursive:true,force:true});}
 });
 it('isolates test data and credentials while preserving normal production paths',()=>{
  const standard=resolveUserDataPath('/data','prod');
  const recorder=resolveUserDataPath('/data','prod',true);
  expect(standard).toBe(path.join('/data','Arkme Harness'));
  expect(recorder).toBe(path.join('/data','Arkme Recorder Test'));
  const standardPolicy=JSON.parse(pluginHostEnvironment(false).ARKME_HOST_POLICY!);
  const testPolicy=JSON.parse(pluginHostEnvironment(false,recorder).ARKME_HOST_POLICY!);
  expect(standardPolicy.credentialServicePrefix).toBeUndefined();
  expect(testPolicy.credentialServicePrefix).toMatch(/^com\.senqisi\.dsh-arkme\.dev\./);
 });
 it('uses a separate installer identity with embedded runtime and no production migration hooks',()=>{
  const require=createRequire(import.meta.url);
  const config=require('../electron-builder.recorder-test.cjs');
  expect(config.appId).toBe('cc.jiwo.arkme.local-test');
  expect(config.nsis.guid).not.toBe(require('../package.json').build.nsis.guid);
  expect(config.nsis.include).toBeUndefined();
  expect(config.win.forceCodeSigning).toBe(false);
  expect(config.mac.identity).toBe('-');
  expect(config.extraResources).toContainEqual(expect.objectContaining({to:'app.asar.unpacked/node_modules'}));
 });
 it('loads through the actual builder configuration merger',async()=>{
  const require=createRequire(import.meta.url);
  const builderRequire=createRequire(require.resolve('electron-builder'));
  const {getConfig}=builderRequire('app-builder-lib/out/util/config/config.js');
  const config=await getConfig(process.cwd(),'electron-builder.recorder-test.cjs',null);
  expect(config.appId).toBe('cc.jiwo.arkme.local-test');
  expect(typeof config.afterPack).toBe('function');
  expect(config.nsis.include).toBeUndefined();
  expect(config.win.signtoolOptions).toBeUndefined();
  expect(config.publish[0].provider).toBe('generic');
 });
});
