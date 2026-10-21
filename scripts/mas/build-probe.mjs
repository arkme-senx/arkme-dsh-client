import { mkdir, readFile, writeFile, cp, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [id, profile] = process.argv.slice(2);
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id ?? '') || !profile)
  throw new Error('Usage: node scripts/mas/build-probe.mjs <build-id> <mac-development-profile>');
const workspace = path.join(root, '.mas-build', id);
await access(profile);
const frozen = JSON.parse(await readFile(path.join(workspace, 'frozen.json'), 'utf8'));
for (const arch of ['arm64', 'x64']) {
  if ((await readFile(path.join(workspace, `${arch}.complete`), 'utf8')).trim() !== frozen.combinationSha256)
    throw new Error(`Incomplete extraction: ${arch}`);
}
const stage = path.join(workspace, 'probe');
await mkdir(stage, { recursive: true });
await cp(path.join(root, 'build/mas/probe-main.cjs'), path.join(stage, 'main.cjs'));
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'jiwo-mas-probe',
  version: frozen.channel.version, main: 'main.cjs', author: 'Jotmo', description: 'MAS sandbox architecture probe' }));
const finalOutput = path.join(root, 'release-mas', id, 'probe', 'mas-dev-universal');
const hookPath = path.join(workspace, 'probe-after-pack.cjs');
await writeFile(hookPath, `const fs = require('node:fs/promises'); const path = require('node:path');
module.exports = async context => {
  if (path.resolve(context.appOutDir) !== ${JSON.stringify(finalOutput)}) return;
  const resources = path.join(context.appOutDir, 'arkme.app', 'Contents', 'Resources');
  await fs.cp(${JSON.stringify(path.join(workspace, 'embedded'))}, path.join(resources, 'embedded'), {recursive:true});
  await fs.copyFile(${JSON.stringify(path.join(workspace, 'frozen.json'))}, path.join(resources, 'frozen.json'));
};`);
const rootRequire = createRequire(path.join(root, 'package.json'));
const builderRequire = createRequire(rootRequire.resolve('electron-builder'));
const libRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const signerPath = libRequire.resolve('@electron/osx-sign');
const signHook = path.join(workspace, 'probe-sign.cjs');
await writeFile(signHook, `const { signAsync } = require(${JSON.stringify(signerPath)});
module.exports = options => signAsync({...options, identity: '73ED76D4647DC9A567C382CE60156F085C71F51B', identityValidation: false});`);
const config = {
  extends: null, appId: frozen.channel.appId, productName: 'Jiwo MAS Probe', executableName: 'arkme',
  electronVersion: frozen.channel.electronVersion, npmRebuild: false, asar: true,
  directories: { app: stage, output: path.join(root, 'release-mas', id, 'probe') },
  files: ['main.cjs', 'package.json'], publish: null,
  afterPack: hookPath,
  mac: { minimumSystemVersion: '12.0', bundleVersion: String(frozen.channel.versionCode),
    icon: path.join(root, 'build/icon.icns'), category: 'public.app-category.productivity',
    mergeASARs: true, x64ArchFiles: '**/embedded/{arm64,x64}/**/*' },
  masDev: { sign: signHook, identity: 'Apple Development: richard chou (6Q3VB9R2RR)',
    provisioningProfile: path.resolve(profile), type: 'development', hardenedRuntime: false,
    entitlements: path.join(root, 'build/mas/entitlements.probe.plist'),
    entitlementsInherit: path.join(root, 'build/mas/entitlements.inherit.plist') }
};
const configPath = path.join(workspace, 'probe-builder.json');
await writeFile(configPath, JSON.stringify(config, null, 2));
const result = spawnSync(path.join(root, 'node_modules/.bin/electron-builder'),
  ['--projectDir', stage, '--config', configPath, '--mac', 'mas-dev', '--universal', '--publish', 'never'],
  { cwd: stage, stdio: 'inherit' });
if (result.status !== 0) throw new Error(`MAS probe build failed: ${result.status}`);
