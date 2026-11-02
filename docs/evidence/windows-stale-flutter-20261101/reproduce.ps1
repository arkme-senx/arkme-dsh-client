$ErrorActionPreference='Stop'
$root=Join-Path $env:USERPROFILE 'Downloads\arkme-stale-validation-20261101'
$destination=Join-Path $root 'electron'
$releaseManifest=Join-Path $root 'admission-manifest.json'
# Admission only needs release identity. This is not a payload/signature test.
@{version='3.0.23';versionCode=301;files=@(@{path='arkme.exe'},@{path='resources/app.asar'})}|ConvertTo-Json -Depth 5|Set-Content -Encoding UTF8 $releaseManifest
$baseline=Join-Path $root 'baseline\build\windows-migration.ps1'
$fixed=Join-Path $root 'fixed\build\windows-migration.ps1'
$results=@()
. $baseline -Action Library -Destination $destination -Scope current -Manifest $releaseManifest
$legacy=Get-LegacyInstall
if(!$legacy -or $legacy.Root -ne (Join-Path $root 'flutter')){throw 'Unexpected legacy root'}
Assert-Legacy $legacy $destination current
'HEALTHY_BASELINE_PASS'
$beforeRegistry=Get-RegistrySnapshots $legacy|ConvertTo-Json -Depth 40 -Compress
$beforeFiles=@(Get-ChildItem $legacy.Root -Recurse -File |Get-FileHash|Select-Object Path,Hash)|ConvertTo-Json -Compress
foreach($case in @('flutter_windows.dll','data\flutter_assets','jotmo.exe','unins000.exe','entire-root')) {
 $source=if($case -eq 'entire-root'){$legacy.Root}else{Join-Path $legacy.Root $case}
 $backup=Join-Path $root 'case-backup'
 if(Test-Path $backup){throw 'Unresolved prior test backup'}
 Move-Item -LiteralPath $source -Destination $backup
 try {
  . $baseline -Action Library -Destination $destination -Scope current -Manifest $releaseManifest
  $found=Get-LegacyInstall
  $oldError=''
  try {Assert-Legacy $found $destination current} catch {$oldError=$_.Exception.Message}
  if(!$oldError){throw 'Baseline unexpectedly accepted broken installation'}
  if($case -in @('flutter_windows.dll','data\flutter_assets','entire-root') -and $oldError -ne 'Unknown Flutter program layout.'){throw ('Wrong reproduction: '+$oldError)}
  . $fixed -Action Library -Destination $destination -Scope current -Manifest $releaseManifest
  $found=Get-LegacyInstall
  $selected=Resolve-MigrationLegacy (Select-MigrationLegacy $found)
  if($selected -or !$script:DetachedLegacy){throw 'Fix did not detach incomplete installation'}
  $link=[pscustomobject]@{Exists=$true;Target=(Join-Path $found.Root 'jotmo.exe');Arguments=''}
  $compatibility=Get-ShortcutCompatibility ([pscustomobject]@{Canonical=$true;Role='Programs'}) $link
  if($compatibility -notin @('stale-flutter','verified-flutter')){throw 'Broken shortcut not supported'}
  $afterRegistry=Get-RegistrySnapshots $found|ConvertTo-Json -Depth 40 -Compress
  if($afterRegistry -ne $beforeRegistry){throw 'Admission mutated registry'}
  $results+=[pscustomobject]@{Case=$case;BaselineError=$oldError;Fixed='PASS';Shortcut=$compatibility;Registry='UNCHANGED'}
  $results[-1]|ConvertTo-Json -Compress
 } finally {Move-Item -LiteralPath $backup -Destination $source}
}
$afterFiles=@(Get-ChildItem $legacy.Root -Recurse -File |Get-FileHash|Select-Object Path,Hash)|ConvertTo-Json -Compress
if($afterFiles -ne $beforeFiles){throw 'Restored legacy file inventory differs'}
. $fixed -Action Library -Destination $destination -Scope current -Manifest $releaseManifest
$legacy=Get-LegacyInstall
if(!(Resolve-MigrationLegacy (Select-MigrationLegacy $legacy))){throw 'Healthy old install stopped migrating'}
Assert-Legacy $legacy $destination current
$results|ConvertTo-Json -Depth 5|Set-Content -Encoding UTF8 (Join-Path $root 'evidence\real-package-reproduction.json')
'REAL_PACKAGE_REPRODUCTION_PASS; files restored byte-for-byte; registry unchanged; healthy migration preserved'
