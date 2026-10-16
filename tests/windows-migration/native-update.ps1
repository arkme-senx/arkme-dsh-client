$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\..\build\windows-migration.ps1" -Action Library
$root=Join-Path ([IO.Path]::GetTempPath()) ('jiwo-native-update-test-'+[guid]::NewGuid())
$Destination=Join-Path $root 'app'
$secure=Join-Path $root 'protected'
$null=New-Item -ItemType Directory $Destination -Force
function Get-ProtectedJournalDirectory { return $secure }
function Get-LegacyInstall { return $script:legacy }
function Assert-ElectronDestination {
  Assert-UpgradeAllowed '3.0.3' 280 '3.0.3' $script:incomingCode
  return $script:registered
}
function Test-RegularUpdate($Existing,$Legacy) { return $Existing -and !$Legacy -and $script:modern }
function Recover-Overlay([switch]$CommittedOnly) {
 if(!$CommittedOnly){throw 'Automatic update must never enable rollback'}
 $dir=Get-JournalDirectory
 $record=[IO.File]::ReadAllText((Join-Path $dir 'journal.json'))
 if($record -ne 'committed'){throw 'Unfinished migration'}
 Remove-Item -LiteralPath $dir -Recurse
}
function Refuses([string]$Reason) {
  $failed=$false
  try { Assert-NativeUpdate } catch { $failed=$true }
  if(!$failed){throw "Expected refusal: $Reason"}
}
try {
 # First migration must keep Flutter in the transaction without requiring existing Arkme.
 $script:registered=$false; $script:incomingCode=281
 foreach ($migrationScope in @('all','current')) {
   $Scope=$migrationScope
   $onlyFlutter=@{Scope=$migrationScope;Root=$root}
   if (!(Select-MigrationLegacy $onlyFlutter) -or $script:PreservedLegacy) {throw 'Flutter-only migration was incorrectly preserved or rejected'}
 }
 $Scope='current'
 $script:legacy=$null; $script:registered=$true; $script:modern=$true; $script:incomingCode=281
 Assert-NativeUpdate
 $script:incomingCode=280; Assert-NativeUpdate
 $script:incomingCode=279; Refuses 'downgrade'; $script:incomingCode=281
 $script:registered=$false; Refuses 'unregistered'; $script:registered=$true
 $script:modern=$false; Refuses 'old identity'; $script:modern=$true
 $script:legacy=@{Scope='current'}; Refuses 'legacy'; $script:legacy=$null
 # Shared Flutter is deliberately outside the per-user update transaction.
 $savedDestination=$Destination
 $Destination=Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AppData\Local\Programs\arkme'
 $script:legacy=@{Scope='all';Root=$root}
 $marker=Join-Path $root 'flutter-keep.txt'; [IO.File]::WriteAllText($marker,'shared-data')
 $effective=Select-MigrationLegacy $script:legacy
 if ($effective -or !(Test-Path -LiteralPath $marker)) { throw 'Shared Flutter must not enter the transaction' }
 $Scope='all'
 if (!(Select-MigrationLegacy $script:legacy)) { throw 'Same-scope legacy migration must remain supported' }
 $Scope='current'
 Assert-NativeUpdate
 if ([IO.File]::ReadAllText($marker) -ne 'shared-data') { throw 'Shared Flutter was changed' }
 if (!$script:PreservedLegacy) { throw 'Shared Flutter preservation was not selected' }
 $script:registered=$false; Refuses 'shared Flutter without existing Arkme'; $script:registered=$true
 $script:legacy=@{Scope='all';Root=$Destination}; Refuses 'overlapping Flutter'
 $script:legacy=$null; $Destination=$savedDestination
 foreach($dir in @((Join-Path $Destination '.jiwo-v3-transaction'),$secure)) {
   $null=New-Item -ItemType Directory $dir
   $marker=Join-Path $dir 'journal.json'; [IO.File]::WriteAllText($marker,'preserve me')
   Refuses 'unresolved recovery'
   if([IO.File]::ReadAllText($marker) -ne 'preserve me'){throw 'Recovery record modified'}
   [IO.File]::WriteAllText($marker,'committed')
   Assert-NativeUpdate
   if(Test-Path $dir){throw 'Committed cleanup did not run'}
 }
 Assert-NativeUpdate
 Write-Output 'Native update admission fixtures passed'
} finally {Remove-Item -LiteralPath $root -Recurse -Force}
