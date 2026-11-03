import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {buildMigrationPackage} from '../build-macos-migration.mjs';
import {runCommand, notarytoolAuthArgs} from '../macos-ci-signing.cjs';

export function assertTestPackageIdentity(info) {
  if (info.CFBundleIdentifier !== 'cc.jiwo.arkme.test' || info.CFBundleName !== 'arkme Test'
    || info.CFBundleExecutable !== 'arkme Test') throw Error('Test PKG must contain only the isolated test identity');
}

// PKG/helper signing needs both identities after electron-builder has disposed
// its own temporary keychain. Never reuse the runner login keychain.
export async function buildCIMacPackage(appRoot, input, temporary) {
  const env = {...input, CI_KEYCHAIN_PASSWORD: randomUUID()};
  const run = (tool, args, capture = false) => runCommand(tool, args, env, capture);
  if (!env.MAC_INSTALLER_LINK || !env.MAC_INSTALLER_PASSWORD) throw Error('Missing Developer ID Installer certificate');
  const keychain = path.join(temporary, 'pkg-signing.keychain-db');
  const previous = [...run('security', ['list-keychains', '-d', 'user'], true).matchAll(/"([^"]+)"/g)].map(m => m[1]);
  try {
    run('security', ['create-keychain', '-p', env.CI_KEYCHAIN_PASSWORD, keychain]);
    run('security', ['set-keychain-settings', '-lut', '21600', keychain]);
    run('security', ['unlock-keychain', '-p', env.CI_KEYCHAIN_PASSWORD, keychain]);
    for (const [name, encoded, password] of [['application', env.CSC_LINK, env.CSC_KEY_PASSWORD], ['installer', env.MAC_INSTALLER_LINK, env.MAC_INSTALLER_PASSWORD]]) {
      const file = path.join(temporary, `${name}.p12`);
      await writeFile(file, Buffer.from(encoded, 'base64'), {mode: 0o600});
      run('security', ['import', file, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign', '-T', '/usr/bin/productbuild', '-T', '/usr/bin/productsign']);
    }
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', env.CI_KEYCHAIN_PASSWORD, keychain]);
    run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...previous]);
    const identities = run('security', ['find-identity', '-v', '-p', 'basic', keychain], true);
    const identity = kind => {
      const matches = [...identities.matchAll(/"(Developer ID (?:Application|Installer):[^"\r\n]+)"/g)]
        .map(m => m[1]).filter(n => n.startsWith(`Developer ID ${kind}:`) && n.endsWith(`(${env.APPLE_TEAM_ID})`));
      if (new Set(matches).size !== 1) throw Error(`Expected one ${kind} identity for the configured team`);
      return matches[0];
    };
    env.CSC_NAME = identity('Application');
    env.JIWO_INSTALLER_IDENTITY = identity('Installer');
    if (env.ARKME_CI_ENV === 'prod') return await buildMigrationPackage({appRoot, outputDirectory: 'release-ci', env});
    if (env.ARKME_CI_ENV !== 'test') throw Error('Unknown package environment');
    const info = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', path.join(appRoot, 'Contents/Info.plist')], true));
    assertTestPackageIdentity(info);
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    const root = path.join(temporary, 'test-payload');
    await mkdir(root);
    run('ditto', ['--rsrc', '--extattr', appRoot, path.join(root, 'arkme Test.app')]);
    const components = path.join(temporary, 'test-components.plist');
    run('pkgbuild', ['--analyze', '--root', root, components]);
    const entries = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', components], true));
    if (entries.length !== 1 || entries[0].RootRelativeBundlePath !== 'arkme Test.app') throw Error('Unexpected test PKG payload');
    for (const entry of entries) {
      entry.BundleIsRelocatable = false;
      entry.BundleIsVersionChecked = true;
      entry.BundleHasStrictIdentifier = true;
    }
    await writeFile(components, JSON.stringify(entries));
    run('plutil', ['-convert', 'xml1', components]);
    const component = path.join(temporary, 'test-component.pkg');
    run('pkgbuild', ['--root', root, '--component-plist', components, '--ownership', 'recommended', '--install-location', '/Applications',
      '--identifier', 'cc.jiwo.arkme.test.installer', '--version', pkg.version, component]);
    const output = path.resolve(`release-ci/arkme Test-${pkg.version}-vc${pkg.versionCode}-universal.pkg`);
    run('productbuild', ['--package', component, '--sign', env.JIWO_INSTALLER_IDENTITY, '--keychain', keychain, output]);
    const result = JSON.parse(run('xcrun', ['notarytool', 'submit', output, ...notarytoolAuthArgs(env), '--wait', '--output-format', 'json'], true));
    if (result.status !== 'Accepted') throw Error('Test PKG notarization not accepted');
    run('xcrun', ['stapler', 'staple', output]);
    return output;
  } finally {
    run('security', ['list-keychains', '-d', 'user', '-s', ...previous]);
    run('security', ['delete-keychain', keychain]);
  }
}
