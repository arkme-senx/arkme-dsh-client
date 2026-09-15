/**
 * Complete reviewed production trust anchor for @senguoyun/dsh-arkme.
 *
 * A production plugin upgrade must regenerate pnpm-lock.yaml, review the
 * resulting artifact metadata and dependency closure, then update every field
 * in this single object in the same reviewed change. The two SHA-256 values are
 * computed from parsed lockfile entries after recursively sorting mapping keys.
 * pnpm set-like arrays listed in unorderedArrayFields are sorted before hashing;
 * every other array keeps its order.
 */
const packageName = "@senguoyun/dsh-arkme";
const packageVersion = "0.1.52";
const commit = "2838fdceea0e4702b9017a31e0ad6f0893fc823a";
const repository = "git@github.com:arkme-senx/arkme-dsh-plugin.git";
const dependencySpec = `git+ssh://git@github.com/arkme-senx/arkme-dsh-plugin.git#${commit}`;
const tarball =
  `https://codeload.github.com/arkme-senx/arkme-dsh-plugin/tar.gz/${commit}`;
const peerSuffix = "(573d2c61500c32345d20c20077cad57d)";

export const productionPluginFingerprint = Object.freeze({
  packageName,
  packageVersion,
  commit,
  repository,
  dependencySpec,
  tarball,
  peerSuffix,
  importerResolution: `${tarball}${peerSuffix}`,
  packageResolutionKey: `${packageName}@${tarball}`,
  snapshotKey: `${packageName}@${tarball}${peerSuffix}`,
  integrity:
    "sha512-sfAkMLLEHniTWw2zu+ECpTIcoJJxkLyuBb7bDCuWotEmeJPkwV9hevOX4v9NbZ+IsoAqI82Ze7B5huK7voHBZA==",
  packageEntrySha256:
    "f1cb163ae99ab1a5f4a6f75409b016ecd10ba9de9d34ad3a112ad48a1f4b05d9",
  snapshotSha256:
    "e3b17d4854d9113d5107f0af64c1eade943cfd84426efd417843bab41618cc8e",
  unorderedArrayFields: Object.freeze([
    "bundledDependencies",
    "cpu",
    "libc",
    "os",
    "transitivePeerDependencies"
  ]),
  allowBuilds: Object.freeze({
    "@arkme/macos-notification-permission@file:native/macos-notification-permission": true,
    "@deepseek-ai/dsh-subprocess-local": true,
    "@google/genai": false,
    [`${packageName}@${dependencySpec}`]: true,
    [`${packageName}@${tarball}`]: true,
    electron: true,
    "electron-winstaller": false,
    esbuild: true,
    koffi: true,
    "node-pty": true,
    protobufjs: false
  })
});
