import { test } from 'vitest';
import assert from 'node:assert/strict';
import { patchInstallSection, validateReleaseIdentity, planLegacyMigration } from '../../scripts/windows-migration-policy.mjs';
test('production identity cannot migrate test or unsigned packages', () => {
  assert.throws(() => validateReleaseIdentity({ appId: 'cc.jiwo.arkme.test' }), /production/);
  assert.throws(() => validateReleaseIdentity({ appId: 'cc.jiwo.arkme', unsigned: true }), /signed/);
});
test('ambiguous installs, overlap, scope mismatch and unknown layouts fail closed', () => {
  const item = { root: 'D:\\Apps\\jotmo', scope: 'user', signed: true, knownLayout: true };
  assert.throws(() => planLegacyMigration([item,item], 'C:\\Apps\\arkme','user'), /multiple/);
  assert.throws(() => planLegacyMigration([item], 'D:\\Apps\\jotmo\\new','user'), /overlap/);
  assert.throws(() => planLegacyMigration([item], 'C:\\Apps\\arkme','all'), /scope/);
  assert.throws(() => planLegacyMigration([{...item,knownLayout:false}], 'C:\\Apps\\arkme','user'), /layout/);
  assert.throws(() => planLegacyMigration([{...item,signed:false}], 'C:\\Apps\\arkme','user'), /signature/);
  assert.deepEqual(planLegacyMigration([item], 'C:\\Apps\\arkme','user').retire, ['jotmo.exe', 'unins000.exe']);
});
test('unknown NSIS templates fail closed', () => { assert.throws(() => patchInstallSection('changed upstream'), /template/); });

test('machine registration inside current profile can coexist with existing per-user Arkme', () => {
  const item={ root: 'C:/Users/me/Desktop/jotmo', scope:'all', signed:true, knownLayout:true };
  const context={profile:'C:/Users/me',elevated:true,existingArkme:true,otherProfiles:0};
  assert.equal(planLegacyMigration([item],'C:/Users/me/Apps/arkme','current',context).scope,'all');
  assert.throws(()=>planLegacyMigration([item],'C:/Users/me/Apps/arkme','current',{...context,elevated:false}),/scope/);
  assert.throws(()=>planLegacyMigration([{...item,root:'C:/Users/other/jotmo'}],'C:/Users/me/Apps/arkme','current',context),/scope/);
});

test('mixed scopes preserve target scope and block shared-source migration for other profiles', () => {
 const context={profile:'C:/Users/me',elevated:true,existingArkme:true,programRoots:['C:/Program Files'],otherProfiles:0};
 const source={root:'C:/Program Files/jotmo',scope:'all',signed:true,knownLayout:true};
 assert.equal(planLegacyMigration([source],'C:/Users/me/Apps/arkme','current',context).scope,'all');
 assert.throws(()=>planLegacyMigration([source],'C:/Users/me/Apps/arkme','current',{...context,otherProfiles:1}),/scope/);
 assert.throws(()=>planLegacyMigration([source],'C:/Users/me/Apps/arkme','current',{...context,otherProfiles:undefined}),/scope/);
 assert.equal(planLegacyMigration([{...source,root:'C:/Users/me/Apps/jotmo',scope:'current'}],'D:/Apps/arkme','all',{...context,otherProfiles:1}).scope,'current');
});
