import { expect, test } from 'vitest';
import { hasCompletedPackagedRuntimeStartup, resolvePackagedRuntimeCacheRoot } from '../scripts/packaged-smoke-lib.mjs';

test('uses the epoch exported by the shipped app instead of the legacy cache root', () => {
  expect(resolvePackagedRuntimeCacheRoot('/tmp/user', 'export const RUNTIME_CACHE_EPOCH = 3;')).toBe('/tmp/user/runtime-manager/electron-v1/cache-epoch-3');
  expect(() => resolvePackagedRuntimeCacheRoot('/tmp/user', 'const unrelated = 3;')).toThrow();
});

test('requires candidate commit then clean authenticated renderer evidence for the same active release', () => {
  const state = { activeReleaseId: 'release-a' };
  const release = { releaseId: 'release-a' };
  const completed = 'runtime-candidate-complete {"releaseId":"release-a"}\n';
  const ready = 'render-ready {"url":"http://127.0.0.1:4321/"}\n';
  expect(hasCompletedPackagedRuntimeStartup({ state, release, log: completed + ready })).toBe(true);
  expect(hasCompletedPackagedRuntimeStartup({ state, release, log: ready })).toBe(false);
  expect(hasCompletedPackagedRuntimeStartup({ state, release, log: ready + completed })).toBe(false);
  expect(hasCompletedPackagedRuntimeStartup({ state: { ...state, probationReleaseId: 'release-a' }, release, log: completed + ready })).toBe(false);
  expect(hasCompletedPackagedRuntimeStartup({ state, release: { releaseId: 'release-b' }, log: completed + ready })).toBe(false);
  expect(hasCompletedPackagedRuntimeStartup({ state, release, log: completed + 'render-ready {"url":"http://127.0.0.1:4321/?token=not-accepted"}' })).toBe(false);
});
