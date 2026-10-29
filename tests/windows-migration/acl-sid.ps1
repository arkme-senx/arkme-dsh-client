# Elevated Windows-only regression. Only test-owned files/ACLs are modified.
param([string]$MigrationScript="$PSScriptRoot\..\..\build\windows-migration.ps1")
$ErrorActionPreference='Stop'
. $MigrationScript -Action Library
function Assert-True($Value,[string]$Message) { if (!$Value) { throw $Message } }
function New-Rule([string]$Sid,[Security.AccessControl.FileSystemRights]$Rights,[Security.AccessControl.AccessControlType]$Type='Allow',[Security.AccessControl.InheritanceFlags]$Inheritance='None',[Security.AccessControl.PropagationFlags]$Propagation='None') {
  return New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($Sid)),$Rights,$Inheritance,$Propagation,$Type)
}
function Set-FixtureAcl([string]$Path,$Rules=@(),[string]$Owner='S-1-5-32-544') {
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($Owner)))
  foreach($sid in @('S-1-5-18','S-1-5-32-544')) {
    $acl.AddAccessRule((New-Rule $sid 'FullControl' 'Allow' 'ContainerInherit, ObjectInherit'))
  }
  foreach($rule in $Rules) { $acl.AddAccessRule($rule) }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Assert-Rejected([string]$Path,[bool]$Ancestor,[string]$Expected) {
  $message=''
  try { Assert-ProtectedObject $Path $Ancestor } catch { $message=$_.Exception.Message }
  Assert-True ($message -like $Expected) ('Expected safety rejection '+$Expected+'; got '+$message)
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('jiwo-acl-sid-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory $root
try {
  $Destination=Join-Path $root 'destination'
  $null=New-Item -ItemType Directory $Destination
  $readers=@('S-1-15-2-1','S-1-15-2-2') | ForEach-Object {New-Rule $_ 'ReadAndExecute' 'Allow' 'ContainerInherit, ObjectInherit'}
  Set-FixtureAcl $Destination $readers
  Assert-ProtectedObject $Destination $false
  $raw=@((Get-Acl $Destination).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  foreach($sid in @('S-1-15-2-1','S-1-15-2-2')) {
    Assert-True (@($raw | Where-Object {$_.IdentityReference.Value -eq $sid}).Count -eq 1) 'Application-package ACE missing from real fixture ACL.'
  }
  Write-Output 'PASS standard application-package read ACEs'
  $child=Join-Path $Destination 'inherited-read'
  $null=New-Item -ItemType Directory $child
  Assert-ProtectedObject $child $false
  Assert-True (@((Get-Acl $child).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IsInherited -and $_.IdentityReference.Value -eq 'S-1-15-2-1'}).Count -gt 0) 'Inherited ACE fixture missing.'
  Write-Output 'PASS inherited application-package read ACEs'

  # Exercise the same real Get-OverlayEntries -> Assert-ProtectedObject path as
  # Apply, without changing registrations, shortcuts or installed applications.
  $stage=Join-Path $root 'stage'; $null=New-Item -ItemType Directory $stage
  $signed=Join-Path $PSHOME 'powershell.exe'
  $signature=Get-AuthenticodeSignature $signed
  Assert-True ($signature.Status -eq 'Valid') 'Signed Windows fixture is invalid.'
  $Publisher=$signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)
  foreach($file in @('arkme.exe','Uninstall arkme.exe')) {Copy-Item $signed (Join-Path $stage $file)}
  [IO.File]::WriteAllText((Join-Path $stage 'app.asar'),'test payload')
  $Manifest=Join-Path $root 'manifest.json'
  $files=@('arkme.exe','app.asar') | ForEach-Object {@{path=$_;sha256=(Get-FileHash (Join-Path $stage $_) -Algorithm SHA256).Hash.ToLowerInvariant();size=(Get-Item (Join-Path $stage $_)).Length}}
  @{version='3.0.20';versionCode=298;files=@($files)} | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $Manifest
  $Scope='all'
  Assert-True (@(Get-OverlayEntries $stage 'Uninstall arkme.exe').Count -eq 3) 'Machine-wide overlay planning must pass with read-only package ACEs.'
  Write-Output 'PASS machine-wide overlay planning with signed payload'

  $orphan='S-1-5-21-111111111-222222222-333333333-4242'
  $current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach($sid in @('S-1-15-2-1','S-1-15-2-2',$orphan,$current)) {
    foreach($right in @('Write','Delete','DeleteSubdirectoriesAndFiles','ChangePermissions','TakeOwnership')) {
      Set-FixtureAcl $Destination @((New-Rule $sid $right))
      Assert-Rejected $Destination $false 'Untrusted write, deletion, or ACL-control permission*'
      if($right -ne 'Write') {Assert-Rejected $Destination $true 'Untrusted write, deletion, or ACL-control permission*'}
    }
  }
  Write-Output 'PASS dangerous application-package, unmapped SID and user grants remain blocked'
  Set-FixtureAcl $Destination @((New-Rule $orphan 'Write'))
  Assert-ProtectedObject $Destination $true
  Assert-Rejected $Destination $false 'Untrusted write, deletion, or ACL-control permission*'
  Write-Output 'PASS ancestor write semantics preserved'
  Set-FixtureAcl $Destination @((New-Rule $orphan 'Write' 'Deny'))
  Assert-ProtectedObject $Destination $false
  Write-Output 'PASS deny ACE does not grant unsafe access'
  Set-FixtureAcl $Destination @((New-Rule $orphan 'Write' 'Allow' 'ContainerInherit' 'InheritOnly'))
  Assert-ProtectedObject $Destination $false
  $inherited=Join-Path $Destination 'inherited-write'; $null=New-Item -ItemType Directory $inherited
  Assert-Rejected $inherited $false 'Untrusted write, deletion, or ACL-control permission*'
  Write-Output 'PASS inherit-only parent and effective child write semantics preserved'
  Set-FixtureAcl $Destination @() $current
  Assert-Rejected $Destination $false 'Untrusted owner*'
  Write-Output 'PASS untrusted owner remains blocked'
  Write-Output 'Windows ACL SID regression tests passed.'
} finally {
  # No system path is ever written by this fixture.
  Remove-Item -LiteralPath $root -Recurse -Force
}
