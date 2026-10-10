# No registry writes, process termination, installation, or uninstall. Real temporary files only.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\..\build\windows-migration.ps1" -Action Library
function Assert-True($Condition, $Message) { if (!$Condition) { throw $Message } }
$root = Join-Path ([IO.Path]::GetTempPath()) ('jiwo-migration-test-'+[Guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $root
try {
  Assert-True (Test-LegacyDisplayIdentity '即我 version 2.0.0' '2.0.0') 'Inno default AppVerName display must be recognized'
  Assert-True (Test-LegacyDisplayIdentity '即我 版本 2.0.0' '2.0.0') 'localized Inno display must be recognized'
  Assert-True (!(Test-LegacyDisplayIdentity '即我 version 2.1.0' '2.0.0')) 'display version mismatch must fail closed'
  Assert-True (Test-TrustedOwnerSid 'S-1-5-32-544') 'Administrators-owned journal must be recognized'
  Assert-True (!(Test-TrustedOwnerSid 'S-1-5-21-100-200-300-1001')) 'a user-owned journal must not be trusted for elevated restore'
  Assert-WindowsCompatibility ([version]'10.0.19045') 9
  foreach ($case in @(@([version]'6.3',9),@([version]'10.0',12))) {
    $failed=$false; try { Assert-WindowsCompatibility $case[0] $case[1] } catch { $failed=$true }
    Assert-True $failed 'unsupported OS/native architecture must abort before mutation'
  }
  Assert-UpgradeAllowed '2.61.25+261' 0 '3.0.0' 277
  foreach ($v in @('2.61.25+278','2.61.25+unknown')) {
    $failed=$false; try { Assert-UpgradeAllowed $v 0 '3.0.0' 277 } catch { $failed=$true }
    Assert-True $failed 'Flutter build suffix must not bypass downgrade/unknown-version protection'
  }
  Assert-True (Test-LegacyUninstallerIdentity 'NotSigned' '' 'Setup/Uninstall' '即我') 'historical unsigned Inno uninstaller must be recognized without executing it'
  Assert-True (Test-LegacyUninstallerIdentity 'Valid' $Publisher 'Setup/Uninstall' '即我') 'signed Inno uninstaller must remain supported'
  foreach ($args in @(@('HashMismatch',$Publisher,'Setup/Uninstall','即我'),@('Valid','Other','Setup/Uninstall','即我'),@('NotSigned','','Unknown','即我'),@('NotSigned','','Setup/Uninstall','Other'))) {
    Assert-True (!(Test-LegacyUninstallerIdentity @args)) 'unknown or invalidly signed uninstallers must be rejected'
  }
  Assert-True (Test-UserLocalCoexistence 'all' 'current' 'C:\Users\me\Desktop\jotmo' 'C:\Users\me\Apps\arkme' 'C:\Users\me' $true $true) 'same-user machine registration should support existing per-user Arkme'
  foreach ($args in @(@('all','current','C:\Program Files\jotmo','C:\Users\me\Apps\arkme','C:\Users\me',$true,$true),@('all','current','C:\Users\other\jotmo','C:\Users\me\Apps\arkme','C:\Users\me',$true,$true),@('all','current','C:\Users\me\jotmo','C:\Users\me\Apps\arkme','C:\Users\me',$false,$true),@('all','current','C:\Users\me\jotmo','C:\Users\me\Apps\arkme','C:\Users\me',$true,$false))) {
    Assert-True (!(Test-UserLocalCoexistence @args)) 'shared/cross-user/non-elevated/unregistered scope conflict must remain blocked'
  }
  Assert-UpgradeAllowed '0.3.0' 10 '3.0.0' 275
  Assert-UpgradeAllowed '3.0.0' 275 '3.0.0' 275
  foreach ($case in @(@('3.1.0',1),@('3.0.0',276),@('3.0.0.276',0),@('2.0.0',276),@('0.3.0',276))) {
    $failed=$false; try { Assert-UpgradeAllowed $case[0] $case[1] '3.0.0' 275 } catch { $failed=$true }
    Assert-True $failed 'higher installed version/build must not be overwritten'
  }
  $budget=Get-DiskRequirements 'C:\' 'C:\' 1000 500 200
  Assert-True ($budget['C:\'] -ge 2700) 'same-volume capacity must cover staging, overlay, backup and cached installer'
  $withoutBackup=Get-DiskRequirements 'C:\' 'D:\' 1000 0 200
  $withBackup=Get-DiskRequirements 'C:\' 'D:\' 1000 500 200
  Assert-True (($withBackup['C:\']-$withoutBackup['C:\']) -ge 1000) 'capacity must reserve original backups plus atomic restoration scratch'
  Assert-True (Test-ArkmeNode 'C:\Users\me\AppData\Roaming\Arkme Harness\runtime-manager\node.exe' '') 'owned dynamic kernel must be recognized'
  Assert-True (!(Test-ArkmeNode 'C:\Program Files\nodejs\node.exe' 'node unrelated-project.js')) 'unrelated node processes must remain outside migration'
  Assert-True (!(Test-ArkmeNode 'C:\Users\me\AppData\Roaming\Arkme Harness Test\runtime-manager\node.exe' '')) 'test runtime must stay isolated'
  $programRoots=@('C:\Program Files','C:\Program Files (x86)')
  Assert-True (Test-InstallScopeCompatibility 'all' 'current' 'C:\Program Files\jotmo' 'C:\Users\me\Apps\arkme' 'C:\Users\me' $true $true $programRoots 0) 'single-user shared Flutter must migrate to registered user Arkme'
  Assert-True (!(Test-InstallScopeCompatibility 'all' 'current' 'C:\Program Files\jotmo' 'C:\Users\me\Apps\arkme' 'C:\Users\me' $true $true $programRoots 1)) 'other user profiles must preserve shared Flutter'
  Assert-True (Test-InstallScopeCompatibility 'current' 'all' 'C:\Users\me\Apps\jotmo' 'C:\Program Files\arkme' 'C:\Users\me' $true $true $programRoots 1) 'user Flutter must migrate into existing all-user Arkme'
  Assert-True (!(Test-InstallScopeCompatibility 'current' 'all' 'C:\Users\other\Apps\jotmo' 'C:\Program Files\arkme' 'C:\Users\me' $true $true $programRoots 0)) 'another user source must stay protected'

  $locations = @(Get-LegacyRegistryLocations)
  Assert-True ($locations.Count -eq 3) 'discovery must inspect one shared HKCU view and both HKLM views'
  Assert-True (@($locations | Where-Object { $_.Hive -eq 'CurrentUser' }).Count -eq 1) 'shared HKCU uninstall keys must not count twice'
  $launcher = Join-Path $root 'jotmo.exe'
  $data = Join-Path $root 'unknown-local-data.db'
  [IO.File]::WriteAllText($launcher,'old signed executable fixture')
  [IO.File]::WriteAllText($data,'precious local data')
  $failed = $false
  try { Invoke-Retirement @($launcher) { throw 'registration access denied' } } catch { $failed = $true }
  Assert-True $failed 'registration failure must propagate'
  Assert-True (Test-Path -LiteralPath $launcher) 'failed commit must restore launcher'
  Assert-True (!(Test-Path -LiteralPath ($launcher+$RetiredSuffix))) 'failed commit must restore original name'
  Assert-True ([IO.File]::ReadAllText($data) -eq 'precious local data') 'unknown data must remain unchanged'
  $second = Join-Path $root 'shortcut.lnk'
  [IO.File]::WriteAllText($second,'shortcut fixture')
  [IO.File]::WriteAllText(($second+$RetiredSuffix),'existing unknown backup')
  $failed = $false
  try { Invoke-Retirement @($launcher,$second) { throw 'should not reach commit' } } catch { $failed = $true }
  Assert-True $failed 'backup collision must abort'
  Assert-True (Test-Path -LiteralPath $launcher) 'partial retirement must restore earlier files'
  Assert-True ([IO.File]::ReadAllText(($second+$RetiredSuffix)) -eq 'existing unknown backup') 'unknown backups must never be overwritten'
  Invoke-Retirement @($launcher) { }
  Assert-True (!(Test-Path -LiteralPath $launcher)) 'successful commit must disable old launcher'
  Assert-True (Test-Path -LiteralPath ($launcher+$RetiredSuffix)) 'successful commit must retain recovery backup'
  Assert-True ([IO.File]::ReadAllText($data) -eq 'precious local data') 'successful migration must preserve local data'
  # Full overlay, backup integrity and journal recovery now run on every host in recovery.ps1.
  if ([Environment]::OSVersion.Platform -eq 'Win32NT') {
  foreach ($bad in @('C:\','\\server\share\app','C:\apps\..\data','C:\apps\file:stream')) {
    $failed = $false
    try { $null = Assert-LocalPath $bad } catch { $failed = $true }
    Assert-True $failed "unsafe path accepted: $bad"
  }
  }
  Write-Output 'Windows migration filesystem transaction tests passed.'
} finally {
  # This is a test-owned randomized temp fixture, never an installed program directory.
  Remove-Item -LiteralPath $root -Recurse -Force
}
