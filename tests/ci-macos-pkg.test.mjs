import {test, expect} from 'vitest';
import {assertTestPackageIdentity} from '../scripts/ci/build-macos-pkg.mjs';

test('test PKG rejects production and partially renamed application identities', () => {
 const isolated = {CFBundleIdentifier:'cc.jiwo.arkme.test', CFBundleName:'arkme Test', CFBundleExecutable:'arkme Test'};
 expect(() => assertTestPackageIdentity(isolated)).not.toThrow();
 for (const bad of [
  {...isolated, CFBundleIdentifier:'com.senqisi.Jotmo'},
  {...isolated, CFBundleName:'即我'},
  {...isolated, CFBundleExecutable:'arkme'},
 ]) expect(() => assertTestPackageIdentity(bad)).toThrow();
});
