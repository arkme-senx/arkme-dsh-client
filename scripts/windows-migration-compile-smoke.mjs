// Compile the real migration macros against a non-installing fixture. Never run its output.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { patchShortcutMacros } from './windows-migration-policy.mjs';
const compiler = process.env.ARKME_TEST_MAKENSIS;
if (!compiler || !process.env.ARKME_TEST_NSIS_PLUGINS) throw new Error('Set ARKME_TEST_MAKENSIS, NSISDIR and ARKME_TEST_NSIS_PLUGINS to the verified electron-builder NSIS toolset/plugins.');
const root = await mkdtemp(path.join(tmpdir(), 'jiwo-nsis-compile-'));
const escaped = value => value.replaceAll('$', () => '$$').replaceAll('"', '$\\"');
try {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const { nsisTemplatesDir } = builderRequire('app-builder-lib/out/targets/nsis/nsisUtil.js');
  const installer = patchShortcutMacros(await readFile(path.join(nsisTemplatesDir, 'include/installer.nsh'), 'utf8'));
  const shortcutMacros = ['addStartMenuLink', 'addDesktopLink'].map(name => {
    const macro = installer.match(new RegExp(`!macro ${name} keepShortcuts[\\s\\S]*?!macroend`));
    if (!macro) throw new Error('Missing patched shortcut macro');
    return macro[0];
  }).join('\n');
  await writeFile(path.join(root, 'payload.bin'), 'Compilation fixture, never execute.');
  await writeFile(path.join(root, 'manifest.json'), '{"version":"3.0.0","versionCode":275,"files":[]}');
  const fixture = `Unicode true
Name "Jiwo migration compile fixture - never run"
OutFile "${escaped(path.join(root, 'compile-only.exe'))}"
RequestExecutionLevel user
!define JIWO_MIGRATION_SCRIPT "${escaped(path.resolve('build/windows-migration.ps1'))}"
!define JIWO_MIGRATION_MANIFEST "${escaped(path.join(root, 'manifest.json'))}"
!define JIWO_VERSION_CODE 275
!define APP_ID "cc.jiwo.arkme"
!addplugindir /x86-unicode "${escaped(process.env.ARKME_TEST_NSIS_PLUGINS || '')}"
!define UNINSTALL_FILENAME "Uninstall arkme.exe"
!define UNINSTALL_REGISTRY_KEY "Software\\JiwoCompileFixtureNeverRun"
!include "${escaped(path.resolve('build/windows-migration.nsh'))}"
!include "LogicLib.nsh"
!include "${escaped(path.join(nsisTemplatesDir, 'include', 'UAC.nsh'))}"
!define INSTALL_REGISTRY_KEY "Software\\JiwoCompileFixtureNeverRun"
!macro setInstallModePerUser
  StrCpy $installMode CurrentUser
!macroend
Var installMode
Var newStartMenuLink
Var newDesktopLink
Var oldStartMenuLink
Var oldDesktopLink
Var appExe
Var keepShortcuts
!define APP_DESCRIPTION "Fixture"
!define isNoDesktopShortcut '"0" == "1"'
!macro createMenuDirectory
!macroend
!macro cleanupOldMenuDirectory
!macroend
${shortcutMacros}
!macro installApplicationFiles
  File /oname=arkme.exe "${escaped(path.join(root, 'payload.bin'))}"
  File "/oname=Uninstall arkme.exe" "${escaped(path.join(root, 'payload.bin'))}"
!macroend
!macro setLinkVars
  StrCpy $newStartMenuLink "$INSTDIR\\fixture-menu.lnk"
  StrCpy $newDesktopLink "$INSTDIR\\fixture-desktop.lnk"
!macroend
!insertmacro customHeader
Function .onInit
  StrCpy $installMode CurrentUser
  StrCpy $INSTDIR "$TEMP\\jiwo-compile-fixture-never-run"
  StrCpy $keepShortcuts true
  StrCpy $oldStartMenuLink "$INSTDIR\\old-menu.lnk"
  StrCpy $oldDesktopLink "$INSTDIR\\old-desktop.lnk"
  StrCpy $appExe "$INSTDIR\\arkme.exe"
  !insertmacro customInit
FunctionEnd
Section
  !insertmacro windowsMigrationGracefulCheck
  !insertmacro windowsMigrationPrepare
  !insertmacro windowsMigrationStage
  !insertmacro customInstall
  !insertmacro addStartMenuLink $keepShortcuts
  !insertmacro addDesktopLink $keepShortcuts
  !insertmacro windowsMigrationFinalize
SectionEnd
`;
  const source = path.join(root, 'compile-only.nsi');
  await writeFile(source, fixture);
  const output = execFileSync(compiler, ['-V3', source], { encoding: 'utf8', env: process.env });
  if (/warning\s+\d+/i.test(output)) throw new Error(output);
  process.stdout.write(output);
} finally {
  // Only this randomized test-owned directory; never execute the fixture installer.
  await rm(root, { recursive: true, force: true });
}
