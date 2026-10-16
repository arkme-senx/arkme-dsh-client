import {it, expect} from 'vitest';
import {mkdtemp, mkdir, writeFile, chmod, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {prepareReceiptPermissions, verifyBundlePermissions} from '../../scripts/mas/permissions.mjs';

it('rejects private receipts and directories, and makes both embedded receipts public', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mas-permissions-'));
  try {
    await chmod(root, 0o755);
    for (const arch of ['arm64', 'x64']) {
      await mkdir(path.join(root, arch));
      await writeFile(path.join(root, arch, 'install-receipt.json'), '{}', {mode: 0o600});
    }
    await expect(verifyBundlePermissions(root)).rejects.toThrow('mode=600');
    await prepareReceiptPermissions(root);
    await verifyBundlePermissions(root);
    for (const arch of ['arm64', 'x64']) expect((await stat(path.join(root, arch, 'install-receipt.json'))).mode & 0o777).toBe(0o644);
    await chmod(path.join(root, 'arm64'), 0o700);
    await expect(verifyBundlePermissions(root)).rejects.toThrow('mode=700');
  } finally { await rm(root, {recursive:true, force:true}); }
});
