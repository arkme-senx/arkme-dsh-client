# Use a private target and registry namespace, never the installed client.
$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\..\build\windows-migration.ps1" -Action Library
$id=[guid]::NewGuid().ToString('N')
$root=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ("ArkmeRepairFixture-"+$id)
$Destination=Join-Path $root 'app'
$null=New-Item -ItemType Directory $Destination -Force
$namespace="Software\ArkmeRepairFixture\$id"
$ElectronKeys=@("$namespace\Install","$namespace\Uninstall","$namespace\Protocol")
$base=[Microsoft.Win32.Registry]::CurrentUser
$Manifest=Join-Path $root 'release.json'
@{version='3.0.28';versionCode=306;files=@(@{path='arkme.exe'},@{path='asset'})} | ConvertTo-Json | Set-Content -Encoding UTF8 $Manifest
function Expect-Rejection([scriptblock]$Inspect,[string]$Pattern) {
  try { $null=& $Inspect } catch { if ($_.Exception.Message -match $Pattern) { return }; throw }
  throw "Expected rejection matching $Pattern"
}
try {
  $key=$base.CreateSubKey($ElectronKeys[0])
  try { $key.SetValue('InstallLocation',$Destination); $key.SetValue('ShortcutName','arkme') } finally { $key.Dispose() }
  $key=$base.CreateSubKey($ElectronKeys[1])
  try {
    $key.SetValue('DisplayVersion','3.0.23')
    $key.SetValue('DisplayName','即我 3.0.23')
    $key.SetValue('JiwoVersionCode',301)
    $key.SetValue('UninstallString','"'+(Join-Path $Destination 'Uninstall arkme.exe')+'" /currentuser')
    if (Assert-ElectronDestination -AllowManualRepair) { throw 'Empty target must use fresh-install collision checks.' }
    Expect-Rejection { Assert-ElectronDestination } 'arkme\.exe'
    $key.SetValue('JiwoVersionCode',307)
    Expect-Rejection { Assert-ElectronDestination -AllowManualRepair } 'Downgrades'
    $key.SetValue('JiwoVersionCode',301)
    $key.SetValue('DisplayName','Other')
    Expect-Rejection { Assert-ElectronDestination -AllowManualRepair } 'Incomplete Arkme registration'
    $key.SetValue('DisplayName','即我 3.0.23')
    Set-Content (Join-Path $Destination 'unknown.txt') 'preserve'
    Expect-Rejection { Assert-ElectronDestination -AllowManualRepair } 'Uninstall arkme\.exe'
    Set-Content (Join-Path $Destination 'Uninstall arkme.exe') 'unsigned'
    Expect-Rejection { Assert-ElectronDestination -AllowManualRepair } 'Untrusted program signature'
    Set-Content (Join-Path $Destination 'arkme.exe') 'unsigned'
    Expect-Rejection { Assert-ElectronDestination -AllowManualRepair } 'Untrusted program signature'
  } finally { $key.Dispose() }
  Write-Output 'Missing launcher safeguards passed.'
} finally {
  $base.DeleteSubKeyTree($namespace,$false)
  Remove-Item -LiteralPath $root -Recurse -Force
}
