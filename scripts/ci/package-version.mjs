// package.json is the sole version arithmetic input for new release runs.
export function nextPackageVersion(pkg) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(pkg.version);
  if (!match || !Number.isInteger(pkg.versionCode) || pkg.versionCode <= 0 || pkg.versionCode >= 2147483647) throw Error('Invalid package version or versionCode');
  return {version: `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}`, version_code: pkg.versionCode + 1};
}
export function assertReservedVersion(batch, target) {
  if (batch.version !== target.version || batch.version_code !== target.version_code) throw Error('Backend reservation differs from package.json + 1; deploy the matching backend or use a new source commit. Refusing a silently increased version');
}
