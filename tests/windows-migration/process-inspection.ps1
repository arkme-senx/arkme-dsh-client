$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\..\build\windows-migration.ps1') -Action Library
$root=Join-Path $env:TEMP ('jiwo-process-tests-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$fixture=$null
function Assert-True($value,$message) { if(!$value){throw $message} }
function Assert-Blocked([scriptblock]$action,$message) {
  $blocked=$false
  try { & $action | Out-Null } catch { $blocked=$true }
  Assert-True $blocked $message
}
function Get-CimInstance($ClassName,$Filter) {
  if($script:mode -eq 'foreign-owner') { return $script:foreignItem }
  if($script:mode -eq 'protected') { return [pscustomobject]@{Name='arkme.exe';ProcessId=4;CreationDate=$null;ExecutablePath=$null;CommandLine=$null} }
  $item=CimCmdlets\Get-CimInstance Win32_Process -Filter ('ProcessId='+$script:fixture.Id)
  if($script:mode -eq 'missing-path') {$item.CimInstanceProperties['ExecutablePath'].Value=$null}
  if($script:mode -eq 'stale-pid') {$item.CimInstanceProperties['CreationDate'].Value=$item.CreationDate.AddSeconds(-1)}
  if($script:mode -eq 'exit-before-owner') {$script:fixture.Kill();$script:fixture.WaitForExit()}
  return $item
}
function Invoke-CimMethod { throw 'WMI owner lookup must not be used.' }
try {
  Copy-Item "$env:SystemRoot\System32\ping.exe" (Join-Path $root 'arkme.exe')
  $script:fixture=Start-Process (Join-Path $root 'arkme.exe') -ArgumentList '-t','127.0.0.1' -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 150
  $script:mode='normal'
  $items=@(Get-MigrationProcesses @($root))
  Assert-True ($items.Count -eq 1 -and $items[0].ProcessId -eq $fixture.Id) 'Live owned process missing.'
  Assert-True ($items[0].ExecutablePath -eq (Join-Path $root 'arkme.exe')) 'Native path mismatch.'
  $script:mode='missing-path'
  Assert-True (@(Get-MigrationProcesses @($root)).Count -eq 1) 'Missing CIM path was not recovered.'
  $script:mode='normal'
  Assert-True (@(Get-MigrationProcesses @($root+'-outside')).Count -eq 0) 'Unrelated app included.'
  $script:mode='stale-pid'
  Assert-Blocked { Get-MigrationProcesses @($root) } 'Stale PID metadata was trusted.'
  $script:mode='protected'
  Assert-Blocked { Get-MigrationProcesses @($root) } 'Live unreadable process was ignored.'
  $script:mode='normal'
  $held=[JiwoMigrationProcess]::Open($fixture.Id)
  try {
    Assert-True ($held.OwnerSid() -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) 'Token owner mismatch.'
    $fixture.Kill();$fixture.WaitForExit()
    Assert-True $held.HasExited 'Held handle did not detect exit.'
  } finally {$held.Dispose()}
  $script:fixture=Start-Process (Join-Path $root 'arkme.exe') -ArgumentList '-t','127.0.0.1' -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 150
  $script:mode='exit-before-owner'
  Assert-True (@(Get-MigrationProcesses @($root)).Count -eq 0) 'Exited process was not ignored.'
  Assert-True ($null -eq [JiwoMigrationProcess]::Open($fixture.Id)) 'Exited PID still returned.'
  foreach($name in @('Jotmo-Kernel.exe','node.exe')) {
    Copy-Item "$env:SystemRoot\System32\ping.exe" (Join-Path $root $name)
    $script:fixture=Start-Process (Join-Path $root $name) -ArgumentList '-t','127.0.0.1' -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 150
    $script:mode='normal'
    Assert-True (@(Get-MigrationProcesses @($root)).Count -eq 1) ('Owned process missing: '+$name)
    if($name -eq 'Jotmo-Kernel.exe') {
      Assert-Blocked { Get-MigrationProcesses @($root+'-outside') } 'Unverified kernel was ignored.'
    } else {
      Assert-True (@(Get-MigrationProcesses @($root+'-outside')).Count -eq 0) 'Unrelated Node process included.'
    }
    $fixture.Kill();$fixture.WaitForExit()
  }
  # Read-only foreign-token boundary check when the host grants token access.
  # Only the enumerated name is injected; PID, creation time, path and token are real.
  $foreignChecked=$false
  foreach($item in @(CimCmdlets\Get-CimInstance Win32_Process -Filter "Name = 'services.exe' OR Name = 'svchost.exe'")) {
    $handle=$null
    try {
      $handle=[JiwoMigrationProcess]::Open($item.ProcessId)
      if(!$handle -or $handle.OwnerSid() -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){continue}
      $script:foreignItem=[pscustomobject]@{Name='arkme.exe';ProcessId=$item.ProcessId;CreationDate=$item.CreationDate;ExecutablePath=$handle.Path;CommandLine=$null}
      $foreignRoot=Split-Path $handle.Path -Parent
    } catch {continue} finally {if($handle){$handle.Dispose()}}
    $script:mode='foreign-owner'
    $message=''
    try { Get-MigrationProcesses @($foreignRoot) | Out-Null } catch {$message=$_.Exception.Message}
    Assert-True ($message -like '*another Windows user*') 'Foreign process owner was not rejected.'
    $foreignChecked=$true
    break
  }
  Write-Output ('Foreign token boundary checked: '+$foreignChecked)
  Write-Output 'Windows process inspection regression tests passed.'
} finally {
  if($fixture -and !$fixture.HasExited){$fixture.Kill();$fixture.WaitForExit()}
  Remove-Item -LiteralPath $root -Recurse -Force
}
