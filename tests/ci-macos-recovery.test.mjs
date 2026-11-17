import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import YAML from 'yaml';
import {recovery, validateRecoverySource, validateRecoveryFiles, validateRecoveryGrant} from '../scripts/ci/recover-macos-313.mjs';

const source = () => [
  {id: recovery.run, head_sha: recovery.source, head_branch: 'master', event: 'push', status: 'completed',
    path: '.github/workflows/build-pre-release.yml', repository: {full_name: recovery.repository}},
  {id: recovery.job, run_id: recovery.run, conclusion: 'success'},
  {id: recovery.artifact, expired: false, name: `arkme-${recovery.source}-macos`,
    digest: `sha256:${recovery.archiveSHA256}`, workflow_run: {id: recovery.run, head_sha: recovery.source}},
];

describe('fixed Mac artifact recovery', () => {
  it('accepts the original successful Mac build even when the combined run failed', () => {
    const input = source(); input[0].conclusion = 'failure';
    expect(() => validateRecoverySource(...input)).not.toThrow();
  });
  it.each([
    [0, 'head_sha', 'f'.repeat(40)], [0, 'head_branch', 'dev'], [0, 'event', 'pull_request'],
    [0, 'status', 'in_progress'], [0, 'path', '.github/workflows/untrusted.yml'],
    [1, 'id', 1], [1, 'run_id', 1], [1, 'conclusion', 'failure'],
    [2, 'id', 1], [2, 'expired', true], [2, 'digest', 'sha256:wrong'], [2, 'name', 'other'],
  ])('rejects mismatched evidence %s/%s', (part, field, value) => {
    const input = source(); input[part][field] = value;
    expect(() => validateRecoverySource(...input)).toThrow();
  });
  it('rejects a different repository or artifact run', () => {
    const input = source(); input[0].repository.full_name = 'attacker/fork';
    expect(() => validateRecoverySource(...input)).toThrow();
    const other = source(); other[2].workflow_run.head_sha = 'a'.repeat(40);
    expect(() => validateRecoverySource(...other)).toThrow();
  });
  it('rejects edited metadata before reading or uploading any artifact', async () => {
    const bytes = readFileSync(new URL('./fixtures/macos-313-platform.json', import.meta.url));
    const meta = JSON.parse(bytes); meta.batch_id = 'a'.repeat(40);
    let reads = 0;
    await expect(validateRecoveryFiles(Buffer.from(JSON.stringify(meta)), async () => {reads++; return Buffer.alloc(0);})).rejects.toThrow('metadata changed');
    expect(reads).toBe(0);
  });
  it('rejects corrupted bytes from the genuine metadata', async () => {
    const bytes = readFileSync(new URL('./fixtures/macos-313-platform.json', import.meta.url));
    await expect(validateRecoveryFiles(bytes, async () => Buffer.from('corrupt'))).rejects.toThrow('artifact bytes changed');
  });
  it('only accepts the exact existing production object grant', () => {
    const name = '即我-3.0.35-vc313-universal.pkg';
    const key = 'app/arkme/prod/macos/3.0.35-vc313/' + name;
    expect(() => validateRecoveryGrant({object_key: key, url: 'https://d.jiwo.cc/' + key}, name)).not.toThrow();
    expect(() => validateRecoveryGrant({object_key: key, url: new URL('https://d.jiwo.cc/' + key).href}, name)).not.toThrow();
    for (const url of ['https://attacker.invalid/' + key, 'https://d.jiwo.cc/' + key + '?token=x', 'http://d.jiwo.cc/' + key]) {
      expect(() => validateRecoveryGrant({object_key: key, url}, name)).toThrow();
    }
    expect(() => validateRecoveryGrant({object_key: key.replace('/prod/', '/test/'), url: 'https://d.jiwo.cc/' + key}, name)).toThrow();
    expect(() => validateRecoveryGrant({object_key: key, url: 'https://d.jiwo.cc/' + key}, '../arbitrary')).toThrow();
  });
  it('keeps production credentials behind a master-only manual workflow', () => {
    const flow = YAML.parse(readFileSync(new URL('../.github/workflows/recover-macos-313.yml', import.meta.url), 'utf8'));
    expect(Object.keys(flow.on)).toEqual(['workflow_dispatch']);
    expect(flow.jobs.upload.if).toContain("github.ref == 'refs/heads/master'");
    expect(flow.jobs.upload.environment).toBe('prod');
    expect(flow.permissions).toEqual({contents: 'read', actions: 'read'});
    const credentials = flow.jobs.upload.steps.filter(step => step.env?.ARKME_CI_SECRET);
    expect(credentials).toHaveLength(1);
    expect(credentials[0].run).toBe('node scripts/ci/recover-macos-313.mjs upload');
    expect(flow.jobs.upload.steps.some(step => /publish|writeback|reserve/.test(step.run ?? ''))).toBe(false);
  });
});
