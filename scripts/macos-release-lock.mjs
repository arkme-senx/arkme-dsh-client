import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function withMacReleaseLock(directory, action, { invalidateReport = true } = {}) {
  const lock = path.join(directory, '.jiwo-release-build.lock');
  await mkdir(directory, { recursive: true });
  try { await mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another macOS release build holds release/.jiwo-release-build.lock; verify its owner before removing a stale lock');
    throw error;
  }
  try {
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    // Never leave an earlier signed publication request after a failed rebuild
    // or preparation attempt. Other files in this directory are not ours.
    const publication = path.join(directory, 'publication');
    const info = await lstat(publication).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info && !info.isDirectory()) throw new Error('Unexpected publication directory object');
    for (const filename of ['release-request.json', 'upload-map.json', 'latest-mac.yml']) {
      await rm(path.join(publication, filename), { force: true });
      await rm(path.join(publication, `${filename}.tmp`), { force: true });
    }
    if (invalidateReport) {
      const report = path.join(directory, 'jiwo-release-verification.json');
      await rm(report, { force: true });
      await rm(`${report}.tmp`, { force: true });
    }
    return await action();
  } finally { await rm(lock, { recursive: true, force: true }); }
}
