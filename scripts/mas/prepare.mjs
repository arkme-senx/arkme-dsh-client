import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, open, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freezeReleaseSet } from './release-set.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(root);
const args = process.argv.slice(2);
const buildId = args[args.indexOf('--build-id') + 1];
if (!args.includes('--build-id') || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(buildId ?? ''))
  throw new Error('Specify --build-id <name>. Reuse that ID for retries and TestFlight promotion.');
const channel = JSON.parse(await readFile('build/mas/channel.json', 'utf8'));
const directory = path.join(root, '.mas-build', buildId);
await mkdir(directory, { recursive: true });
const lock = await open(path.join(directory, '.lock'), 'wx');
try {
  const compiler = path.join(directory, 'compiler');
  const compile = spawnSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.build.json', '--outDir', compiler], { stdio: 'inherit' });
  if (compile.status !== 0) throw new Error('MAS isolated TypeScript compilation failed');
  const load = name => import(pathToFileURL(path.join(compiler, `runtime/${name}.js`)).href);
  const { fetchElectronRuntimeManifest } = await load('client');
  const { parseElectronRuntimeManifest } = await load('manifest');
  const context = arch => ({ os: 'darwin', arch, shellVersion: channel.version,
    electronMajor: channel.electronMajor, modulesAbi: channel.modulesAbi });
  const frozen = await freezeReleaseSet({ directory, channel,
    fresh: args.includes('--resolve-new'),
    parseManifest: (document, arch) => parseElectronRuntimeManifest(document, context(arch), { requiredShellVersionCode: channel.releaseSetShellVersionCode ?? channel.versionCode }),
    fetchManifest: arch => fetchElectronRuntimeManifest({ serviceBaseUrl: channel.serviceBaseUrl,
      platform: 'darwin', arch, shellVersion: channel.version, shellVersionCode: channel.releaseSetShellVersionCode ?? channel.versionCode,
      electronMajor: channel.electronMajor, modulesAbi: channel.modulesAbi, fetcher: fetch }) });
  console.log(`Frozen MAS combination: ${frozen.combinationSha256}`);
  if (!args.includes('--resolve-only')) {
    const { installElectronRuntimeRelease, validateInstalledElectronRuntime } = await load('installer');
    for (const arch of ['arm64', 'x64']) {
      const target = path.join(directory, 'embedded', arch);
      const marker = path.join(directory, `${arch}.complete`);
      let complete = false;
      try { await access(marker); complete = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!complete) {
        // Only remove the partial, build-private extraction. Never touch website runtime/cache.
        await rm(target, { recursive: true, force: true });
        await installElectronRuntimeRelease(frozen.manifests[arch], target, {
          downloadsPath: path.join(directory, 'downloads'), fetcher: fetch
        });
        await writeFile(marker, frozen.combinationSha256 + '\n');
      }
      if ((await readFile(marker, 'utf8')).trim() !== frozen.combinationSha256)
        throw new Error(`MAS extraction marker mismatch: ${arch}`);
      await validateInstalledElectronRuntime(frozen.manifests[arch], target);
    }
    const metadata = await Promise.all(['arm64', 'x64'].map(async arch => JSON.parse(await readFile(
      path.join(directory, 'embedded', arch, frozen.manifests[arch].artifacts.harness.metadata), 'utf8'))));
    if (metadata[0].buildId !== metadata[1].buildId) throw new Error('Harness architectures have different source build IDs');
  }
  await writeFile(path.join(directory, 'preparation-report.json'), JSON.stringify({ status: 'prepared',
    combinationSha256: frozen.combinationSha256, signed: false, sandboxValidated: false }, null, 2));
} catch (error) {
  await writeFile(path.join(directory, 'preparation-report.json'), JSON.stringify({ status: 'blocked',
    message: error.message, details: error.technicalDetails ?? error.stack, signed: false, sandboxValidated: false }, null, 2));
  throw error;
} finally {
  await lock.close();
  await rm(path.join(directory, '.lock'));
}
