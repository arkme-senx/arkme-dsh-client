import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextPackageVersion, assertReservedVersion} from '../scripts/ci/package-version.mjs';
test('increments only package.json, including a new major/minor line', () => {
 assert.deepEqual(nextPackageVersion({version:'3.0.25',versionCode:303}), {version:'3.0.26',version_code:304});
 assert.deepEqual(nextPackageVersion({version:'4.1.0',versionCode:400}), {version:'4.1.1',version_code:401});
});
test('rejects invalid versions and code overflow', () => {
 for (const version of ['3.0.01','3.0.25-rc.1','3.0.25+foo','v3.0.25']) assert.throws(()=>nextPackageVersion({version,versionCode:303}));
 for (const versionCode of [0,-1,1.2,'303',2147483647]) assert.throws(()=>nextPackageVersion({version:'3.0.25',versionCode}));
});
test('old backend or historical batch cannot silently raise target', () => {
 const target=nextPackageVersion({version:'3.0.25',versionCode:303});
 assert.doesNotThrow(()=>assertReservedVersion(target,target));
 assert.throws(()=>assertReservedVersion({version:'3.0.55',version_code:333},target));
});
