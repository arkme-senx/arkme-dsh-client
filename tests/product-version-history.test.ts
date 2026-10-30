import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProductVersionHistory } from '../src/product-version-history.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'arkme-version-history-'));
  directories.push(directory);
  const file = path.join(directory, 'history.json');
  return { file, store: new ProductVersionHistory(file) };
}
describe('desktop product version history', () => {
  it('persists client-only updates across restarts and clears them when the plugin changes', async () => {
    const { file, store } = await fixture();
    expect(await store.observe('3.0.38', 218)).toBe(false);
    expect(await store.observe('3.0.38', 219)).toBe(true);
    const restarted = new ProductVersionHistory(file);
    expect(await restarted.observe('3.0.38', 219)).toBe(true);
    expect(await restarted.observe('3.0.38', 220)).toBe(true);
    expect(await restarted.observe('3.0.39', 220)).toBe(false);
    expect(await new ProductVersionHistory(file).observe('3.0.39', 220)).toBe(false);
  });
  it('gives simultaneous plugin changes precedence and does not treat rollback as an upgrade', async () => {
    const { store } = await fixture();
    await store.observe('3.0.38', 218);
    expect(await store.observe('3.0.39', 219)).toBe(false);
    expect(await store.observe('3.0.39', 220)).toBe(true);
    expect(await store.observe('3.0.39', 219)).toBe(false);
    expect(await store.observe('3.0.38', 219)).toBe(false);
  });
  it('serializes concurrent observations without losing client-only status', async () => {
    const { store } = await fixture();
    await store.observe('3.0.38', 218);
    expect(await Promise.all([store.observe('3.0.38', 219), store.observe('3.0.38', 219)])).toEqual([true, true]);
  });
  it('recovers malformed history and ignores invalid input without replacing the baseline', async () => {
    const { file, store } = await fixture();
    await writeFile(file, '{');
    expect(await store.observe('3.0.38', 218)).toBe(false);
    expect(await store.observe(null, 219)).toBe(false);
    expect(await store.observe('3.0.38', NaN)).toBe(false);
    expect(await store.observe('3.0.38', 219)).toBe(true);
  });
});
