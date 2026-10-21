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
const packageVersion = "3.0.18";
const commit = "9497ad8f963ca18af9ce8a39664e8fe1faa20a0b";
const repository = "git@github.com:arkme-senx/arkme-dsh-plugin.git";
const dependencySpec = `git+ssh://git@github.com/arkme-senx/arkme-dsh-plugin.git#${commit}`;
const tarball =
  `https://codeload.github.com/arkme-senx/arkme-dsh-plugin/tar.gz/${commit}`;
const peerSuffix = "(b2c8acc20c8162a78a0f1d1d6952239e)";

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
    "sha512-UROZnkoVSL5SganV19TdPAs4Y+PYDPTXM2I/cR8Y8PoHcDAy5nV+gcyNiae85LZnyxPUTQ/Sc7HSbVg9PXWTvw==",
  packageEntrySha256:
    "4218e1145b68c4a084f84ba5019f6d3c0f36d59ffbda21d687df8fe44faa3349",
  snapshotSha256:
    "61dc197479b007aa4fceac27a3808013cff5edeca4fdd1c890468e498f93bdcf",
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
