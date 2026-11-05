# Exercise the production catch/finally path with isolated side effects and a local transport spy.
$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('jiwo-cancel-reporting-'+[guid]::NewGuid())
$null=New-Item -ItemType Directory $root
$source=Get-Content "$PSScriptRoot\..\..\build\windows-migration.ps1" -Raw -Encoding UTF8
$stubs=@'
function Get-CimInstance {param($Class) return [pscustomobject]@{Version='10.0.26200';Architecture=9}}
function Get-ReleaseManifest {return @{version='3.0.26';versionCode=304}}
function Initialize-JournalLocation {}
function Get-JournalDirectory {return (Join-Path $PSScriptRoot 'journal')}
function Stop-Normally {
  if ($Action -eq 'Check') {
    if ($env:JIWO_CANCEL_FIXTURE -eq 'ordinary-failure') {throw 'Could not cancel a service operation'}
    Invoke-MigrationExit { @([pscustomobject]@{Name='fixture.exe';ProcessId=0}) } {$false} {throw 'must not close'} {throw 'must not wait'}
  }
}
function Recover-Overlay {if ($env:JIWO_CANCEL_FIXTURE -eq 'rollback-failure') {throw 'Cancellation rollback failed'}}
function Send-InstallerDiagnostic([string]$Json) {
  Add-Content -LiteralPath (Join-Path $PSScriptRoot 'sent.jsonl') -Value $Json -Encoding UTF8
  return $true
}
$originalSave=${function:Save-InstallerDiagnostic}
function Save-InstallerDiagnostic($Report,[string]$Directory,[scriptblock]$Send) {
  & $originalSave $Report (Join-Path $PSScriptRoot 'queue') $Send
}
'@
$anchor="if (`$Action -eq 'Library') { return }"
if (!$source.Contains($anchor)) {throw 'Library boundary changed'}
$source=$source.Replace($anchor,$anchor+"`r`n"+$stubs)
$passed=$false
try {
 foreach ($case in @(
   @{name='cancel';action='Check';context='';code=1602;reports=0},
   @{name='cancel-report';action='Report';context='Cancelled';code=0;reports=0},
   @{name='real-report';action='Report';context='NSIS';code=0;reports=1},
   @{name='cancel-rollback';action='Rollback';context='Cancelled';code=0;reports=0},
   @{name='rollback-failure';action='Rollback';context='Cancelled';code=1;reports=1},
   @{name='ordinary-failure';action='Check';context='';code=1;reports=1}
 )) {
  $directory=Join-Path $root $case.name
  $null=New-Item -ItemType Directory (Join-Path $directory 'journal') -Force
  $worker=Join-Path $directory 'worker.ps1'
  Set-Content -LiteralPath $worker -Value $source -Encoding UTF8
  $env:JIWO_CANCEL_FIXTURE=$case.name
  $arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$worker,'-Action',$case.action,'-Destination',$directory)
  if ($case.context) {$arguments+=@('-FailureContext',$case.context)}
  $process=Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList ($arguments | ForEach-Object {'"'+$_+'"'}) -Wait -PassThru -RedirectStandardOutput (Join-Path $directory 'output.log') -RedirectStandardError (Join-Path $directory 'error.log')
  if ($process.ExitCode -ne $case.code) {throw "$($case.name): expected exit $($case.code), got $($process.ExitCode); $directory"}
  $sent=Join-Path $directory 'sent.jsonl'
  $reports=@()
  if(Test-Path $sent){$reports=@(Get-Content $sent | ForEach-Object {$_ | ConvertFrom-Json})}
  if($reports.Count -ne $case.reports){throw "$($case.name): unexpected upload count $($reports.Count); $directory"}
  foreach($report in $reports){if($report.result -ne 'failure' -or $report.error_code -ne 'INSTALL_FAILED'){throw 'Actual failure was classified as cancellation'}}
  Write-Output "$($case.name): exit=$($case.code) uploads=$($reports.Count)"
 }
 $passed=$true
 Write-Output 'Cancellation reporting integration passed'
} finally {
 Remove-Item Env:JIWO_CANCEL_FIXTURE -ErrorAction SilentlyContinue
 # Randomized fixture only; keep failure evidence when a test throws.
 if ($passed) {Remove-Item $root -Recurse -Force}
}
