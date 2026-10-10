import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { patchInstallSection, patchShortcutMacros } from '../../scripts/windows-migration-policy.mjs';
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const { nsisTemplatesDir } = builderRequire('app-builder-lib/out/targets/nsis/nsisUtil.js');
test('patch applies to installed builder with preflight before any uninstall and verification after extraction', () => {
 const source = readFileSync(path.join(nsisTemplatesDir,'installSection.nsh'),'utf8');
 const result = patchInstallSection(source);
 expect(result).not.toContain('!insertmacro uninstallOldVersion');
 expect(result).not.toContain('!insertmacro handleUninstallResult');
 expect(result.indexOf('!insertmacro windowsMigrationStage')).toBeLessThan(result.indexOf('!insertmacro registryAddInstallInfo'));
 expect(result.indexOf('!insertmacro windowsMigrationFinalize')).toBeGreaterThan(result.indexOf('!insertmacro addDesktopLink'));
 expect(result).not.toContain('!insertmacro installApplicationFiles');
 expect(result).not.toContain('!insertmacro CHECK_APP_RUNNING');
 expect(result.indexOf('!insertmacro customInstall')).toBeLessThan(result.indexOf('!insertmacro addStartMenuLink'));
 expect(result.indexOf('!insertmacro customInstall')).toBeLessThan(result.indexOf('!insertmacro addDesktopLink'));
});
test('production hook normalizes builder CurrentUser scope and declares failure callback after builder headers', () => {
 const multiUser=readFileSync(path.join(nsisTemplatesDir,'multiUser.nsh'),'utf8');
 const hooks=readFileSync('build/windows-migration.nsh','utf8');
 expect(multiUser).toContain('StrCpy $installMode CurrentUser');
 expect(hooks).toContain('StrCpy $JiwoMigrationScope current');
 expect(hooks).toContain('-Scope "$JiwoMigrationScope"');
 expect(hooks.indexOf('!macro customHeader')).toBeLessThan(hooks.indexOf('Function .onInstFailed'));
});
test('builder shortcut rename collisions cannot mutate the retained Flutter link before reconciliation', () => {
 const source=readFileSync(path.join(nsisTemplatesDir,'include/installer.nsh'),'utf8');
 const patched=patchShortcutMacros(source);
 for (const kind of ['StartMenu','Desktop']) {
   const rename=patched.indexOf(`Rename $old${kind}Link $new${kind}Link`);
   const guarded=patched.indexOf('${ifNot} ${Errors}',rename);
   const mutation=patched.indexOf(`WinShell::SetLnkAUMI "$new${kind}Link"`,rename);
   const end=patched.indexOf('${endIf}',guarded);
   expect(patched.slice(rename-20,rename)).toContain('ClearErrors');
   expect(guarded).toBeGreaterThan(rename);
   expect(mutation).toBeGreaterThan(guarded);
   expect(mutation).toBeLessThan(end);
 }
 expect(()=>patchShortcutMacros('upstream changed')).toThrow(/template/);
});
test('test configuration cannot enable production-only migration include', () => {
 const config = require('../../electron-builder.test-config.cjs');
 expect(config.appId).not.toBe('cc.jiwo.arkme');
 expect(config.nsis.include).toBe('build/nsis-installer-ui.nsh');
 expect(readFileSync('build/nsis-installer-ui.nsh','utf8')).toContain('!ifdef JIWO_MIGRATION');
});
test.skipIf(process.platform !== 'win32' && !process.env.ARKME_TEST_PWSH)('Windows filesystem transaction preserves unknown data on success/failure', () => {
 const shell = process.env.ARKME_TEST_PWSH || path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const output = execFileSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('tests/windows-migration/transaction.ps1')],{encoding:'utf8'});
 expect(output).toContain('transaction tests passed');
});
test.skipIf(!process.env.ARKME_TEST_MAKENSIS)('real NSIS compiler accepts production migration macros', () => {
 const output=execFileSync(process.execPath,['scripts/windows-migration-compile-smoke.mjs'],{encoding:'utf8',env:process.env});
 expect(output).toContain('Processed 1 file');
});

test.skipIf(process.platform !== 'win32' && !process.env.ARKME_TEST_PWSH)('shortcut reconciliation preserves original intent, coexistence and startup', () => {
 const shell=process.env.ARKME_TEST_PWSH || path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const output=execFileSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('tests/windows-migration/shortcuts.ps1')],{encoding:'utf8'});
 expect(output).toContain('Shortcut reconciliation fixtures passed');
});

test.skipIf(process.platform !== 'win32' && !process.env.ARKME_TEST_PWSH)('durable journal transitions and interrupted recovery preserve owned state', () => {
 const shell=process.env.ARKME_TEST_PWSH || path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const output=execFileSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('tests/windows-migration/recovery.ps1')],{encoding:'utf8'});
 expect(output).toContain('Durable recovery fixtures passed.');
}, 30_000);

test('production install scope runs before the elevated-child machine-wide default', async () => {
 const {patchInstallModePage}=await import('../../scripts/windows-migration-policy.mjs');
 const source=readFileSync(path.join(nsisTemplatesDir,'multiUserUi.nsh'),'utf8');
 const result=patchInstallModePage(source);
 const hook=result.indexOf('!insertmacro windowsMigrationInstallMode');
 expect(hook).toBeGreaterThan(-1);
 expect(hook).toBeLessThan(result.indexOf('${if} ${UAC_IsInnerInstance}'));
 expect(result.slice(0,hook)).toContain('!ifndef BUILD_UNINSTALLER');
 expect(()=>patchInstallModePage('unknown template')).toThrow(/template/);
 const hooks=readFileSync('build/windows-migration.nsh','utf8');
 expect(hooks).toContain('!insertmacro UAC_AsUser_GetGlobal $R0 $PROFILE');
 expect(hooks).toContain('!macro windowsMigrationInstallMode');
 expect(hooks).toContain('!insertmacro windowsMigrationResolveInstallMode');
});

test.skipIf(process.platform !== 'win32' && !process.env.ARKME_TEST_PWSH)('exit consent, cancellation, retry and native tray selector', () => {
 const shell=process.env.ARKME_TEST_PWSH || path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const output=execFileSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('tests/windows-migration/exit.ps1')],{encoding:'utf8'});
 expect(output).toContain('Migration exit fixtures passed');
});
