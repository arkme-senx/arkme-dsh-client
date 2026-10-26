import { test, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { patchInstallSection, patchShortcutMacros } from '../../scripts/windows-migration-policy.mjs';
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const { nsisTemplatesDir } = builderRequire('app-builder-lib/out/targets/nsis/nsisUtil.js');
const canTestProtectedAcls = process.platform === 'win32' && spawnSync(
 path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
 ['-NoProfile','-NonInteractive','-Command','if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 }; exit 1'],
 { stdio: 'ignore' }
).status === 0;
test('patch applies to installed builder with preflight before any uninstall and verification after extraction', () => {
 const source = readFileSync(path.join(nsisTemplatesDir,'installSection.nsh'),'utf8');
 const result = patchInstallSection(source);
 expect(result).toContain('!insertmacro uninstallOldVersion');
 expect(result).toContain('!insertmacro handleUninstallResult');
 expect(result.indexOf('!insertmacro windowsMigrationStage')).toBeLessThan(result.indexOf('!insertmacro registryAddInstallInfo'));
 expect(result.indexOf('!insertmacro windowsMigrationFinalize')).toBeGreaterThan(result.indexOf('!insertmacro addDesktopLink'));
 expect(result.match(/!insertmacro windowsMigrationStage/g)).toHaveLength(1);
 expect(result).toContain('!insertmacro CHECK_APP_RUNNING');
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
test.skipIf(process.platform !== 'win32')('real Windows short paths verify signed payloads without weakening path safety', () => {
 const shell = path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const output = execFileSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('tests/windows-migration/short-path.ps1')],{encoding:'utf8'});
 expect(output).toContain('Windows short-path regression tests passed.');
}, 60_000);
test.skipIf(!canTestProtectedAcls)('real Windows ACLs use stored SIDs while rejecting unsafe permissions and owners', () => {
 const shell = path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const output = execFileSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('tests/windows-migration/acl-sid.ps1')],{encoding:'utf8'});
 expect(output).toContain('Windows ACL SID regression tests passed.');
}, 60_000);
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
}, 60_000);

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

test('automatic launch is gated on durable finalization and uses synchronous helper exit', () => {
 const source=readFileSync(path.join(nsisTemplatesDir,'installSection.nsh'),'utf8');
 const patched=patchInstallSection(source);
 expect(patched).toContain('$JiwoMigrationCommitted != "1"');
 const hooks=readFileSync('build/windows-migration.nsh','utf8');
 expect(hooks).toContain('ExecWait');
 expect(hooks).not.toContain('nsExec::ExecToLog');
 expect(hooks.indexOf('!insertmacro windowsMigrationRun Finalize')).toBeLessThan(hooks.lastIndexOf('StrCpy $JiwoMigrationCommitted "1"'));
 expect(hooks).toContain('S-1-*');
});

test('native update admission precedes stock uninstall and keeps the manual migration route', () => {
 const result=patchInstallSection(readFileSync(path.join(nsisTemplatesDir,'installSection.nsh'),'utf8'));
 expect(result.indexOf('windowsMigrationRun UpdateCheck')).toBeLessThan(result.indexOf('!insertmacro uninstallOldVersion'));
 const hooks=readFileSync('build/windows-migration.nsh','utf8');
 expect(hooks.match(/!insertmacro installApplicationFiles/g)).toHaveLength(1);
 expect(hooks).toContain('${If} $JiwoNativeUpdate != "1"\n    StrCpy $INSTDIR $JiwoMigrationDestination');
 expect(result).toContain('${If} $JiwoNativeUpdate == "1"\n!insertmacro CHECK_APP_RUNNING\n${Else}\n!insertmacro windowsMigrationGracefulCheck');
});
test.skipIf(process.platform !== 'win32' && !process.env.ARKME_TEST_PWSH)('native update refuses legacy, downgrade and unresolved recovery without mutating them', () => {
 const shell=process.env.ARKME_TEST_PWSH || path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 expect(execFileSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('tests/windows-migration/native-update.ps1')],{encoding:'utf8'})).toContain('Native update admission fixtures passed');
});

test('manual installer verifies final payload before retirement and durable completion without a redundant Commit process', () => {
 const hooks=readFileSync('build/windows-migration.nsh','utf8');
 expect(hooks).not.toContain('!insertmacro windowsMigrationRun Commit');
 const ps=readFileSync('build/windows-migration.ps1','utf8');
 const finalize=ps.slice(ps.indexOf("} elseif ($Action -eq 'Finalize') {"),ps.indexOf('} catch {\n  $message=',ps.indexOf("} elseif ($Action -eq 'Finalize') {")));
 expect(finalize.indexOf('Assert-Payload $Destination $Manifest')).toBeGreaterThan(-1);
 expect(finalize.indexOf('Assert-Payload $Destination $Manifest')).toBeLessThan(finalize.indexOf('Invoke-Retirement'));
 expect(finalize.indexOf('Assert-Payload $Destination $Manifest')).toBeLessThan(finalize.indexOf('Complete-Overlay'));
 expect(finalize.indexOf('Complete-Overlay')).toBeLessThan(finalize.indexOf('if ($CompletionFile)'));
});

 test.skipIf(process.platform !== 'win32')('helper failure preserves raw Unicode error and transcript path for installer display', () => {
 const dir=mkdtempSync(path.join(tmpdir(),'jiwo-error-report-'));
 const errorFile=path.join(dir,'failure.txt');
 const missing=path.join(dir,'缺失-manifest.json');
 const shell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 try {
   let failure;
   try { execFileSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('build/windows-migration.ps1'),'-Action','Check','-Destination',path.join(dir,'app'),'-Manifest',missing,'-ErrorFile',errorFile],{encoding:'utf8',stdio:'pipe'}); } catch (error) { failure=error; }
   expect(failure?.status).toBe(1);
   const report=readFileSync(errorFile,'utf16le');
   expect(report).toContain('完整日志：');
   expect(report).toContain('jiwo-install-');
   expect(report).toContain(missing);
   expect(report).toContain('Failed at:');
 } finally { rmSync(dir,{recursive:true,force:true}); }
 });

 test('shared Flutter preservation guards stock shortcut writers and final AUMID writes', () => {
 const patched=patchInstallSection(readFileSync(path.join(nsisTemplatesDir,'installSection.nsh'),'utf8'));
 expect(patched).toContain('${If} $JiwoPreserveShortcuts != "1"\n!insertmacro addStartMenuLink $keepShortcuts\n!insertmacro addDesktopLink $keepShortcuts\n${EndIf}');
 const hooks=readFileSync('build/windows-migration.nsh','utf8');
 expect(hooks).toContain('${If} $JiwoPreserveShortcuts != "1"\n  ${If} ${FileExists} "$newStartMenuLink"');
 expect(hooks).toContain('ShortcutName "$oldShortcutName"');
 });

test.skipIf(process.platform !== 'win32' || !process.env.ARKME_TEST_MAKENSIS)('production NSIS scope selector runs the nine installation scenarios', () => {
 const output=execFileSync(process.execPath,['scripts/windows-migration-scope-smoke.mjs'],{encoding:'utf8',env:process.env});
 expect(output).toContain('Scope matrix passed: 9 scenarios');
});
test('first Flutter migration detects both machine registry views and locks the inherited scope', () => {
 const source=readFileSync('build/windows-migration.nsh','utf8');
 expect(source).toContain('ReadRegStr $R2 HKCU "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\fcf12080-f7e3-1067-bed2-21ffecf3ae64_is1" InstallLocation');
 expect(source).toContain('SetRegView 32\n  ReadRegStr $R4 HKLM');
 expect(source).toContain('SetRegView 64\n  ${If} $R3 == ""');
 expect(source).toContain('${If} $JiwoMigrationKeepMachine == "1"\n    !insertmacro setInstallModePerAllUsers\n    Abort');
});

test.skipIf(process.platform !== 'win32')('orphan shortcut admission verifies identity, layout, version and rejects unknown targets', () => {
 const shell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const output=execFileSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('tests/windows-migration/shortcut-compatibility.ps1')],{encoding:'utf8'});
 expect(output).toContain('Shortcut compatibility fixtures passed');
});

test.skipIf(process.platform !== 'win32')('installer telemetry failures cannot fail install and queued logs are redacted', () => {
 const shell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const output=execFileSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('tests/windows-migration/diagnostics.ps1')],{encoding:'utf8'});
 expect(output).toContain('Installer diagnostic fixtures passed');
});
