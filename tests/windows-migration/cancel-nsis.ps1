# Runs only a generated fixture: no installer payload, registry changes, or network calls.
param([Parameter(Mandatory=$true)][string]$Makensis)
$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('jiwo-cancel-nsis-'+[guid]::NewGuid())
$null=New-Item -ItemType Directory $root
$worker=Join-Path $root 'worker.ps1'
@'
param([string]$Action,[string]$FailureContext,[string]$Destination,[string]$Scope,[string]$Manifest,[string]$Stage,[string]$UninstallerName,[string]$InstallerPath,[string]$ShortcutPolicyFile,[string]$CompletionFile,[string]$ErrorFile)
if($Action -eq 'Check') {
 if($ErrorFile){[IO.File]::WriteAllText($ErrorFile,'isolated cancellation fixture',[Text.Encoding]::Unicode)}
 exit ([int]$env:JIWO_NSIS_CHECK_CODE)
}
[pscustomobject]@{action=$Action;context=$FailureContext} | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:JIWO_NSIS_ACTIONS
exit 0
'@ | Set-Content -Encoding UTF8 $worker
$include=(Resolve-Path "$PSScriptRoot\..\..\build\windows-migration.nsh").Path
$exe=Join-Path $root 'fixture.exe'
$source=Join-Path $root 'fixture.nsi'
$escape={param($value) $value.Replace('$','$$').Replace('"','$\"')}
@"
Unicode true
Name "Cancellation callback fixture"
OutFile "$(& $escape $exe)"
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
!define UNINSTALL_FILENAME "fixture.exe"
!include "$(& $escape $include)"
Var installMode
!insertmacro customHeader
Section
 InitPluginsDir
 File /oname=`$PLUGINSDIR\windows-migration.ps1 "$(& $escape $worker)"
 StrCpy `$installMode CurrentUser
 StrCpy `$INSTDIR "`$EXEDIR\unused-target"
 StrCpy `$JiwoMigrationCancelled "0"
 ReadEnvStr `$1 "JIWO_NSIS_HAS_TRANSACTION"
 `${If} `$1 == "1"
   StrCpy `$JiwoMigrationDestination `$INSTDIR
 `${EndIf}
 ReadEnvStr `$1 "JIWO_NSIS_USER_ABORT"
 `${If} `$1 == "1"
   Call .onUserAbort
 `${EndIf}
 !insertmacro windowsMigrationRun Check
SectionEnd
"@ | Set-Content -Encoding UTF8 $source
$passed=$false
try {
 & $Makensis /V2 $source
 if($LASTEXITCODE -ne 0){throw 'Cancellation NSIS fixture did not compile'}
 foreach($case in @(
  @{name='cancel-before-transaction';code=1602;transaction=0;abort=0;action='';context=''},
  @{name='failure-before-transaction';code=1;transaction=0;abort=0;action='Report';context='NSIS'},
  @{name='cancel-with-transaction';code=1602;transaction=1;abort=0;action='Rollback';context='Cancelled'},
  @{name='failure-with-transaction';code=1;transaction=1;abort=0;action='Rollback';context='NSIS'},
  @{name='wizard-user-abort';code=1;transaction=0;abort=1;action='';context=''}
 )) {
  $env:JIWO_NSIS_CHECK_CODE=[string]$case.code
  $env:JIWO_NSIS_HAS_TRANSACTION=[string]$case.transaction
  $env:JIWO_NSIS_USER_ABORT=[string]$case.abort
  $env:JIWO_NSIS_ACTIONS=Join-Path $root ($case.name+'.jsonl')
  $p=Start-Process $exe -ArgumentList '/S' -PassThru
  if(!$p.WaitForExit(30000)){ $p.Kill(); throw "Callback fixture timed out: $root" }
  $actions=@()
  if(Test-Path $env:JIWO_NSIS_ACTIONS){$actions=@(Get-Content $env:JIWO_NSIS_ACTIONS | ForEach-Object {$_ | ConvertFrom-Json})}
  if(!$case.action){if($actions.Count -ne 0){throw "$($case.name): cancellation incorrectly reported"}}
  elseif($actions.Count -ne 1 -or $actions[0].action -ne $case.action -or $actions[0].context -ne $case.context){throw "$($case.name): failure/rollback routing incorrect; $root"}
  Write-Output "$($case.name): actions=$($actions.Count) $($case.action) $($case.context)"
 }
 $passed=$true
 Write-Output 'NSIS cancellation callback integration passed'
} finally {
 foreach($key in @('JIWO_NSIS_CHECK_CODE','JIWO_NSIS_HAS_TRANSACTION','JIWO_NSIS_USER_ABORT','JIWO_NSIS_ACTIONS')){Remove-Item ('Env:'+ $key) -ErrorAction SilentlyContinue}
 if($passed){Remove-Item $root -Recurse -Force}
}
