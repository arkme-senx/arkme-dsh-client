# Real junctions and helper actions; private registry, shortcuts, payload and diagnostics.
$ErrorActionPreference='Stop'
$root=Join-Path $env:TEMP ('arkme-shortcut-path-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory $root
$source=Get-Content "$PSScriptRoot\..\..\build\windows-migration.ps1" -Raw -Encoding UTF8
$anchor="if (`$Action -eq 'Library') { return }"
if(!$source.Contains($anchor)){throw 'Missing helper library boundary.'}
$isolation=@'
$fixtureKey='Software\ArkmeShortcutPathTest\'+$env:ARKME_PATH_TEST_ID
$ElectronKeys=@(($fixtureKey+'\Install'),($fixtureKey+'\Uninstall'),($fixtureKey+'\Protocol'))
$LegacyKey=$fixtureKey+'\Legacy'
function Get-ShortcutLocations {
 foreach($role in @('Desktop','Programs','Startup')) {
  [pscustomobject]@{Path=(Join-Path (Join-Path $env:ARKME_PATH_TEST_ROOT $role) 'arkme.lnk');Role=$role;Canonical=$true}
 }
}
function Stop-Normally { Add-Content (Join-Path $env:ARKME_PATH_TEST_ROOT 'exit-requested') 'called' }
# Synthetic payload has no publisher certificate. Keep real path/hash/transaction checks.
function Assert-Publisher([string]$File) { if(!(Test-Path -LiteralPath $File -PathType Leaf)){throw 'Missing fixture executable.'} }
function Save-InstallerDiagnostic($Report,[string]$Directory,[scriptblock]$Send) {
 $Report | ConvertTo-Json -Depth 5 -Compress | Add-Content (Join-Path $env:ARKME_PATH_TEST_ROOT 'reports.jsonl') -Encoding UTF8
}
# Exercise Begin-Overlay independently of action preflight (e.g. a path changed
# while the application was exiting). Do not substitute its transaction logic.
if($env:ARKME_PATH_TEST_DIRECT -eq '1') {
 try { Begin-Overlay $Stage $UninstallerName $null; exit 0 }
 catch { Write-Output $_.Exception.Message; exit 1 }
}
'@
$worker=Join-Path $root 'worker.ps1'
($source.Replace($anchor,$anchor+"`r`n"+$isolation)) | Set-Content $worker -Encoding UTF8
$stage=Join-Path $root 'stage';$null=New-Item -ItemType Directory $stage
foreach($name in @('arkme.exe','fixture.txt','Uninstall arkme.exe')){Set-Content (Join-Path $stage $name) ('fixture '+$name)}
$files=@('arkme.exe','fixture.txt' | ForEach-Object { $file=Join-Path $stage $_; @{path=$_;size=(Get-Item $file).Length;sha256=(Get-FileHash $file).Hash.ToLowerInvariant()} })
$manifest=Join-Path $root 'manifest.json'
@{version='3.0.32';versionCode=310;registryMetadata=@{displayName=([char]0x5373).ToString()+[char]0x6211+' 3.0.32';publisher='Jotmo';description='Desktop client'};files=$files} | ConvertTo-Json -Depth 8 | Set-Content $manifest -Encoding UTF8
$junctions=@();$failures=@()
function Assert-True($Condition,$Message){if(!$Condition){throw $Message}}
function Invoke-Stage($Name) {
 $args=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$worker,'-Action',$Name,'-Destination',$dest,'-Scope','current','-Manifest',$manifest,'-Stage',$stage,'-UninstallerName','Uninstall arkme.exe','-InstallerPath',(Join-Path $stage 'arkme.exe'))
 if($Name -eq 'Rollback'){$args+=@('-FailureContext','NSIS')}
 $ErrorActionPreference='Continue'
 & powershell.exe @args *> (Join-Path $case ($Name+'.txt'))
 return $LASTEXITCODE
}
try {
 foreach($role in @('Desktop','Programs','Startup','Plain')) {
  $case=Join-Path $root $role;$dest=Join-Path $case 'app';$real=Join-Path $case 'actual'
  $null=New-Item -ItemType Directory $case,$dest,$real
  foreach($folder in @('Desktop','Programs','Startup')) {
   $path=Join-Path $case $folder
   if($folder -eq $role){$null=New-Item -ItemType Junction $path -Target $real;$junctions+=$path}
   else{$null=New-Item -ItemType Directory $path}
  }
  $env:ARKME_PATH_TEST_ID=[guid]::NewGuid().ToString('N');$env:ARKME_PATH_TEST_ROOT=$case
  try {
   foreach($action in @('Check','Prepare','Apply')) {
    $exit=Invoke-Stage $action
    if($role -ne 'Plain') {
     Assert-True ($exit -eq 1) "$role $action must reject the missing shortcut's junction ancestor"
     Assert-True (!(Test-Path (Join-Path $case 'exit-requested'))) "$role $action requested application exit before path rejection"
     Assert-True (!(Test-Path (Join-Path $dest '.jiwo-v3-transaction'))) "$role $action left a recovery journal"
     Assert-True (!(Test-Path (Join-Path $dest 'arkme.exe'))) "$role $action wrote the payload"
    } else { Assert-True ($exit -eq 0) "Ordinary path $action failed" }
   }
   if($role -ne 'Plain') {
    $env:ARKME_PATH_TEST_DIRECT='1'
    try { Assert-True ((Invoke-Stage 'Apply') -eq 1) "$role direct overlay must reject the path" }
    finally { $env:ARKME_PATH_TEST_DIRECT='' }
    Assert-True (!(Test-Path (Join-Path $dest '.jiwo-v3-transaction'))) "$role direct overlay left a recovery journal"
   }
   Assert-True ((Invoke-Stage 'Rollback') -eq 0) "$role rollback failed"
   Assert-True (!(Test-Path (Join-Path $dest '.jiwo-v3-transaction'))) "$role rollback left a journal"
   Assert-True (!(Test-Path (Join-Path $dest 'arkme.exe'))) "$role rollback left a new executable"
   Assert-True (@(Get-ChildItem $real -Force).Count -eq 0) "$role mutated junction target"
   $reports=@(Get-Content (Join-Path $case 'reports.jsonl') | ForEach-Object {$_ | ConvertFrom-Json})
   Assert-True (@($reports | Where-Object recovery -eq 'failed').Count -eq 0) "$role reported recovery failure"
   Write-Output "PASS $role missing shortcut preflight and rollback"
  } catch {$failures+=($_.Exception.Message);Write-Output ('FAIL '+$_.Exception.Message)}
 }
 if($failures.Count){throw ($failures -join '; ')}
 Write-Output 'Windows shortcut path preflight fixtures passed.'
} finally {
 # Remove only our junction objects before recursively deleting our private fixture.
 foreach($junction in $junctions){if(Test-Path -LiteralPath $junction){[IO.Directory]::Delete($junction)}}
 Remove-Item -LiteralPath $root -Recurse -Force
}
