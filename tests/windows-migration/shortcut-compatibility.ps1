$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\..\build\windows-migration.ps1" -Action Library
$root=Join-Path ([IO.Path]::GetTempPath()) ('jiwo-shortcut-compat-'+[guid]::NewGuid())
$null=New-Item -ItemType Directory -Path (Join-Path $root 'data/flutter_assets') -Force
function Assert-Publisher {if (!$script:signed) {throw 'invalid signature'}}
function Get-ShortcutTargetVersion {return $script:info}
function Get-ReleaseManifest {return @{version='3.0.12';versionCode=290}}
function Must-Fail([scriptblock]$Body) {try {& $Body} catch {return};throw 'Expected rejection'}
try {
 $location=@{Canonical=$true;Role='Programs'}
 $link=@{Exists=$true;Target=(Join-Path $root 'jotmo.exe');Arguments=''}
 if ((Get-ShortcutCompatibility $location $link) -ne 'stale-flutter') {throw 'stale entry not recognized'}
 [IO.File]::WriteAllText($link.Target,'exe fixture')
 [IO.File]::WriteAllText((Join-Path $root 'flutter_windows.dll'),'dll fixture')
 $script:signed=$true
 $script:info=@{ProductName='即我';OriginalFilename='jotmo.exe';FileMajorPart=2;FileVersion='2.61.34.270';FilePrivatePart=270}
 if ((Get-ShortcutCompatibility $location $link) -ne 'verified-flutter') {throw 'signed orphan rejected'}
 $script:signed=$false; Must-Fail {Get-ShortcutCompatibility $location $link}; $script:signed=$true
 $info.ProductName='other'; Must-Fail {Get-ShortcutCompatibility $location $link}; $info.ProductName='即我'
 $info.FilePrivatePart=291; Must-Fail {Get-ShortcutCompatibility $location $link}; $info.FilePrivatePart=270
 $link.Arguments='--unknown'; Must-Fail {Get-ShortcutCompatibility $location $link}; $link.Arguments=''
 $location.Canonical=$false; Must-Fail {Get-ShortcutCompatibility $location $link}; $location.Canonical=$true
 Remove-Item (Join-Path $root 'flutter_windows.dll'); Must-Fail {Get-ShortcutCompatibility $location $link}
 $link.Target=Join-Path $root 'other.exe'; Must-Fail {Get-ShortcutCompatibility $location $link}
 $link.Target='\\unknown\share\jotmo.exe'; Must-Fail {Get-ShortcutCompatibility $location $link}
 Write-Output 'Shortcut compatibility fixtures passed'
} finally {Remove-Item -LiteralPath $root -Recurse -Force}
