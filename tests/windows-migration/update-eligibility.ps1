# Read-only admission uses real temporary PE metadata and an owned registry namespace.
# Signature and shortcut COM boundaries are substituted; live-signed PE cases are run separately.
$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('jiwo-update-eligibility-'+[guid]::NewGuid())
$null=New-Item -ItemType Directory $root
$manifest=Join-Path $root 'manifest.json'
@{version='3.0.26';versionCode=304;files=@(@{path='arkme.exe'},@{path='resources/app.asar'})} | ConvertTo-Json -Depth 4 | Set-Content $manifest -Encoding UTF8
. "$PSScriptRoot\..\..\build\windows-migration.ps1" -Action Library -Destination $root -Manifest $manifest
$fixtureKey='Software\ArkmeAdmissionProbe\'+[guid]::NewGuid().ToString('N')
$ElectronKeys=@(($fixtureKey+'\Install'),($fixtureKey+'\Uninstall'),($fixtureKey+'\Protocol'))
function Assert-Publisher([string]$File) { if(!(Test-Path $File -PathType Leaf)){throw 'Missing fixture executable'} }
function Get-LegacyInstall { return $null }
function Get-ShortcutLocations { return @() }
function Recover-Overlay { throw 'Preflight must NEVER recover or mutate a journal' }
function Complete-InstallerDiagnostic { throw 'Preflight must NEVER upload telemetry' }
function Register-Fixture {
 $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($ElectronKeys[0])
 try{$key.SetValue('InstallLocation',$Destination);$key.SetValue('ShortcutName','即我');$key.SetValue('MenuDirectory','')}finally{$key.Dispose()}
 $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($ElectronKeys[1])
 try{$key.SetValue('DisplayVersion','3.0.23');$key.SetValue('JiwoVersionCode',301,[Microsoft.Win32.RegistryValueKind]::DWord)}finally{$key.Dispose()}
}
function Expect-Result([string]$Reason) {
 $result=Get-NativeUpdateEligibility
 if($result.reason -ne $Reason -or $result.eligible -ne ($Reason -eq 'eligible')){throw "Expected $Reason, got $($result | ConvertTo-Json -Compress)"}
 Write-Output "eligibility=$Reason"
}
try {
 Add-Type -TypeDefinition @'
using System.Reflection;
[assembly: AssemblyProduct("即我")]
[assembly: AssemblyFileVersion("3.0.23.301")]
public static class ModernAdmissionFixture { public static void Main() {} }
'@ -OutputAssembly (Join-Path $root 'modern.exe') -OutputType ConsoleApplication
 Add-Type -TypeDefinition @'
using System.Reflection;
[assembly: AssemblyProduct("arkme")]
[assembly: AssemblyFileVersion("0.3.2.12")]
public static class LegacyAdmissionFixture { public static void Main() {} }
'@ -OutputAssembly (Join-Path $root 'legacy.exe') -OutputType ConsoleApplication
 Copy-Item (Join-Path $root 'modern.exe') (Join-Path $root 'arkme.exe')
 Expect-Result 'registration-missing-or-ambiguous'
 Register-Fixture
 Expect-Result 'eligible'
 $journal=Join-Path $root '.jiwo-v3-transaction'
 $null=New-Item -ItemType Directory $journal
 Expect-Result 'recovery-required' # Empty directory has no committed ownership record.
 $record=Join-Path $journal 'journal.json';[IO.File]::WriteAllText($record,'must remain untouched')
 Expect-Result 'recovery-required'
 if([IO.File]::ReadAllText($record) -ne 'must remain untouched'){throw 'Preflight mutated recovery record'}
 Remove-Item $journal -Recurse
 Copy-Item (Join-Path $root 'legacy.exe') (Join-Path $root 'arkme.exe') -Force
 Expect-Result 'legacy-identity'
 Copy-Item (Join-Path $root 'modern.exe') (Join-Path $root 'arkme.exe') -Force
 Expect-Result 'eligible'
 $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($ElectronKeys[1],$true)
 try{$key.SetValue('JiwoVersionCode',999,[Microsoft.Win32.RegistryValueKind]::DWord)}finally{$key.Dispose()}
 Expect-Result 'inspection-failed'
 Register-Fixture
 function Get-ShortcutLocations { return @(@{Path='fixture-link'}) }
 function Read-ManagedShortcut { return @{Exists=$true;Target='C:\unrelated\app.exe';Arguments=''} }
 Expect-Result 'shortcut-migration-required'
 Write-Output 'Read-only update eligibility fixtures passed'
}finally{
 [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($fixtureKey,$false)
 Remove-Item $root -Recurse -Force
}
