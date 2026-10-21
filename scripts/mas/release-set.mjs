import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';

export function assertPair(manifests) {
  const { arm64, x64 } = manifests;
  if (!arm64 || !x64) throw new Error('MAS requires both arm64 and x64 release manifests');
  for (const arch of ['arm64', 'x64']) {
    if (manifests[arch].target.os !== 'darwin' || manifests[arch].target.arch !== arch)
      throw new Error(`MAS manifest target mismatch: ${arch}`);
  }
  // Release IDs contain architecture-specific hashes and are intentionally different.
  for (const component of ['harness', 'requiredPlugin']) {
    for (const field of ['version', 'versionCode']) {
      if (arm64.artifacts[component][field] !== x64.artifacts[component][field])
        throw new Error(`MAS architecture pairing mismatch: ${component}.${field}`);
    }
  }
  for (const field of ['runtimeApiVersion', 'dataSchemaVersion', 'pnpmVersion']) {
    if (arm64[field] !== x64[field]) throw new Error(`MAS architecture pairing mismatch: ${field}`);
  }
  for (const field of ['clientRuleRevision', 'pluginRuleRevision']) {
    if (arm64.compatibility?.[field] !== x64.compatibility?.[field])
      throw new Error(`MAS compatibility changed during resolution: ${field}`);
  }
}

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function freezeReleaseSet({ directory, channel, fetchManifest, parseManifest, fresh = false }) {
  await mkdir(directory, { recursive: true });
  const filename = `${directory}/frozen.json`;
  let existing;
  try { existing = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing !== undefined) {
    if (fresh) throw new Error('A frozen combination already exists. Select a new --build-id; never overwrite a frozen build.');
    if (existing.schemaVersion !== 1 || digest(existing.channel) !== digest(channel)
      || existing.combinationSha256 !== digest(existing.manifests))
      throw new Error('Frozen MAS combination or channel identity is invalid');
    for (const arch of ['arm64', 'x64']) parseManifest(existing.manifests[arch], arch);
    assertPair(existing.manifests);
    return existing;
  }
  const manifests = {};
  // Fetch once per architecture. Failures leave no partial authoritative freeze.
  for (const arch of ['arm64', 'x64']) manifests[arch] = await fetchManifest(arch);
  assertPair(manifests);
  const frozen = { schemaVersion: 1, channel, resolvedAt: new Date().toISOString(),
    combinationSha256: digest(manifests), manifests };
  await rm(`${filename}.tmp`, { force: true });
  await writeFile(`${filename}.tmp`, JSON.stringify(frozen, null, 2) + '\n', { flag: 'wx' });
  await rename(`${filename}.tmp`, filename);
  return frozen;
}
