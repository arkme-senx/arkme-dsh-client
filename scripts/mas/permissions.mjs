import {chmod, lstat, readdir} from 'node:fs/promises';
import path from 'node:path';

// Runtime receipts are private in website user data, but public in a MAS bundle.
export async function prepareReceiptPermissions(embedded) {
  for (const arch of ['arm64', 'x64']) {
    const receipt = path.join(embedded, arch, 'install-receipt.json');
    if (!(await lstat(receipt)).isFile()) throw Error(`Invalid MAS receipt: ${receipt}`);
    await chmod(receipt, 0o644);
  }
}

export async function verifyBundlePermissions(root) {
  async function walk(file) {
    const info = await lstat(file);
    if (info.isSymbolicLink()) return; // Bundle link containment is checked separately.
    const required = info.isDirectory() ? 0o555 : 0o444;
    if ((info.mode & required) !== required) {
      throw Error(`MAS bundle is not readable/traversable by all users: ${file} mode=${(info.mode & 0o777).toString(8)}`);
    }
    if (info.isDirectory()) for (const name of await readdir(file)) await walk(path.join(file, name));
  }
  await walk(root);
}
