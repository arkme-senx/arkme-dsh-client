// Build a non-installing probe of the production NSIS scope/elevation macros.
// Its Section only runs read-only identity checks and writes diagnostics to TEMP.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {patchInstallModePage} from './windows-migration-policy.mjs';
const require=createRequire(import.meta.url);
const br=createRequire(require.resolve('electron-builder'));
const {nsisTemplatesDir}=br('app-builder-lib/out/targets/nsis/nsisUtil.js');
const out=path.resolve(process.env.JIWO_UAC_PROBE_DIR || 'release/uac-probe');
const manifest=path.resolve(process.env.JIWO_UAC_PROBE_MANIFEST || 'release/windows-migration-manifest.json');
const compiler=process.env.ARKME_TEST_MAKENSIS,plugins=process.env.ARKME_TEST_NSIS_PLUGINS;
if(!compiler || !plugins) throw new Error('Provide the installed electron-builder NSIS compiler and Unicode plugins');
await mkdir(out,{recursive:true});
const esc=s=>s.replaceAll('$','$$').replaceAll('"','$\\"');
const multi=await readFile(path.join(nsisTemplatesDir,'multiUser.nsh'),'utf8');
const helpers=['setInstallModePerUser','setInstallModePerAllUsers'].map(name=>multi.match(new RegExp(`!macro ${name}[\\s\\S]*?!macroend`))[0]).join('\n');
const page=patchInstallModePage(await readFile(path.join(nsisTemplatesDir,'multiUserUi.nsh'),'utf8'));
const marker='\tFunction "${UNINSTALLER_FUNCPREFIX}${PRE}"\n';
const prefix=page.slice(page.indexOf(marker)+marker.length,page.indexOf('\t\tStrCpy $isForceMachineInstall'));
const probe=`param([string]$Target,[string]$InstallScope)
$ErrorActionPreference='Stop'
try {
 . "$PSScriptRoot\\windows-migration.ps1" -Action Library
 $Destination=$Target; $Scope=$InstallScope; $Manifest=Join-Path $PSScriptRoot 'windows-migration-manifest.json'
 $legacy=Get-LegacyInstall
 Assert-Legacy $legacy $Destination $Scope
 $existing=Assert-ElectronDestination
 $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
 if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or $Scope -ne 'current' -or !$existing) {throw 'Incorrect elevation/scope in NSIS probe'}
 @{result='passed';elevated=$true;scope=$Scope;destination=$Destination;legacyScope=$legacy.Scope;processBits=([IntPtr]::Size*8)} | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $env:TEMP 'jiwo-uac-probe-result.json')
 exit 0
} catch {
 @{result='failed';error=$_.Exception.Message;trace=$_.ScriptStackTrace} | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $env:TEMP 'jiwo-uac-probe-result.json')
 exit 1
}
`;
await writeFile(path.join(out,'probe.ps1'),'\uFEFF'+probe);
const fixture=`Unicode true
Name "Jiwo read-only elevation diagnostic"
OutFile "${esc(path.join(out,'jiwo-uac-probe.exe'))}"
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
!include "x64.nsh"
!include "${esc(path.join(nsisTemplatesDir,'include/UAC.nsh'))}"
!addplugindir /x86-unicode "${esc(plugins)}"
!define FOLDERID_UserProgramFiles {5CD7AEE2-2219-4A67-B85D-6C9CE15660CB}
!define KF_FLAG_CREATE 0x00008000
!define INSTALL_REGISTRY_KEY "Software\\14ace15a-7c69-5467-bedd-7df6c628d51a"
!define APP_FILENAME arkme
!define APP_64
!define JIWO_MIGRATION_SCRIPT "${esc(path.resolve('build/windows-migration.ps1'))}"
!define JIWO_MIGRATION_MANIFEST "${esc(manifest)}"
Var installMode
Var perUserInstallationFolder
Var perMachineInstallationFolder
!macro GetDParameter outVar
 StrCpy \${outVar} ""
!macroend
${helpers}
!include "${esc(path.resolve('build/windows-migration.nsh'))}"
Function .onInit
 SetRegView 64
 !insertmacro setInstallModePerUser
 !insertmacro customInit
 File /oname=$PLUGINSDIR\\probe.ps1 "${esc(path.join(out,'probe.ps1'))}"
FunctionEnd
Function ProbeMode
${prefix}
FunctionEnd
Section
 ; Silent probe explicitly invokes the same production page prologue, including Abort.
 Call ProbeMode
 ; ProbeMode's Abort returns from a page callback in production; here it aborts
 ; the section, so mode evidence is captured by the dedicated callback below.
SectionEnd
`;
// Abort must retain its actual page-callback semantics. Use an instfiles-only
// visible probe with the real mode page prologue preceding its read-only section.
const section=`Section
 StrCpy $R6 "current"
 \${If} $installMode == "all"
   StrCpy $R6 "all"
 \${EndIf}
 StrCpy $R4 "0"
 \${If} \${UAC_IsInnerInstance}
   StrCpy $R4 "1"
 \${EndIf}
 FileOpen $R5 "$TEMP\\jiwo-uac-probe-nsis.txt" w
 FileWrite $R5 "inner=$R4 scope=$installMode destination=$INSTDIR$\\r$\\n"
 FileClose $R5
 nsExec::ExecToLog '"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\\probe.ps1" -Target "$INSTDIR" -InstallScope "$R6"'
 Pop $0
 SetErrorLevel $0
 Quit
SectionEnd
`;
const source=fixture.replace('SilentInstall silent','Page custom ProbeMode\nPage instfiles').replace(/Section\n[\s\S]*$/,section);
await writeFile(path.join(out,'probe.nsi'),source);
process.stdout.write(execFileSync(compiler,['/V3',path.join(out,'probe.nsi')],{encoding:'utf8'}));
console.log(path.join(out,'jiwo-uac-probe.exe'));
