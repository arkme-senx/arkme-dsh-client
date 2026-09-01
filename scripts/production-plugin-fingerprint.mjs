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
const packageVersion = "0.1.29";
const commit = "e817cb21e3923c8e903d68d442f3227c9e6c78ef";
const repository = "git@github.com:arkme-senx/arkme-dsh-plugin.git";
const dependencySpec = `git+ssh://git@github.com/arkme-senx/arkme-dsh-plugin.git#${commit}`;
const tarball =
  `https://codeload.github.com/arkme-senx/arkme-dsh-plugin/tar.gz/${commit}`;
const peerSuffix = "(2e4ae8833cffc2b8e2a560f0f5496f1a)";

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
    "sha512-bCBOmvdcR+wrLluFEbHtjntX4t7r476oNEV6faZ22oa1Si+eX6Jgu/jysR+w3dgTRN/swByyH55oK00ZOCxnuw==",
  packageEntrySha256:
    "4c9b00a0d20b888bccd0e92f2ca1cbb2793fbf036471103d98e4fdf203778cf9",
  snapshotSha256:
    "ea6472eea320bde6e61a48f5c2177a8959871b6fd5426939b303d9e290e07e6c",
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
