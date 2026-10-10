$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\..\build\windows-migration.ps1" -Action Library
function Assert-True($value,$message){if(!$value){throw $message}}
$script:requests=0;$script:prompts=0;$script:reads=0
$app=[pscustomobject]@{Name='jotmo.exe';ProcessId=1;ExecutablePath='C:\owned\jotmo.exe'}
Invoke-MigrationExit { @() } {throw 'empty process list must not prompt'} {throw 'empty process list must not exit'} {throw 'empty process list must not wait'}
$failed=$false
try {Invoke-MigrationExit { @($app) } {$false} { $script:requests++ } {throw 'cancel must not wait'}} catch {$failed=$true}
Assert-True ($failed -and $script:requests -eq 0) 'cancel must abort before closing anything'
Invoke-MigrationExit { $script:reads++;if($script:reads -eq 1){@($app)}else{@()} } {$script:prompts++;$true} {param($items);$script:requests++;Assert-True ($items.Count -eq 1) 'request should include exact observed process'} { @() }
Assert-True ($script:prompts -eq 1 -and $script:requests -eq 1) 'approved exit must request then recheck processes'
$script:reads=0;$script:prompts=0;$script:requests=0;$script:waits=0
Invoke-MigrationExit {if($script:waits -ge 2){@()}else{@($app)}} {param($items,$retry);$script:prompts++;Assert-True ($retry -eq ($script:prompts -eq 2)) 'retry must identify a failed prior attempt';$true} {$script:requests++} {$script:waits++;if($script:waits -eq 1){@($app)}else{@()}}
Assert-True ($script:prompts -eq 2 -and $script:requests -eq 2) 'failure must offer retry instead of silently killing a process'
if([Environment]::OSVersion.Platform -eq 'Win32NT') {
 Initialize-MigrationExitNative
 Assert-True ([JiwoMigrationExit]::IsExitLabel('退出')) 'historical verified tray uses bare exit label'
 Assert-True ([JiwoMigrationExit]::IsExitLabel('退出即我')) 'localized actual tray exit must match'
 Assert-True ([JiwoMigrationExit]::IsExitLabel('E&xit Jiwo')) 'known English tray exit must match'
 Assert-True (![JiwoMigrationExit]::IsExitLabel('退出登录')) 'logout must never match application exit'
 Assert-True (![JiwoMigrationExit]::IsExitLabel('打开即我')) 'open action must never match exit'
}
Write-Output 'Migration exit fixtures passed'
