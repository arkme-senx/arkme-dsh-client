# Interactive elevated Windows-only fixture; creates only test-owned temporary files.
$ErrorActionPreference='Stop'
try {
 . "$PSScriptRoot\..\..\build\windows-migration.ps1" -Action Library
 $case=Join-Path ([IO.Path]::GetTempPath()) ('jiwo-protected-probe-'+[Guid]::NewGuid())
 $Destination=Join-Path $case 'app';$Scope='current'
 $null=New-Item -ItemType Directory $Destination -Force
 Initialize-JournalLocation ([pscustomobject]@{Scope='all'})
 New-JournalDirectory
 $directory=Get-JournalDirectory
 Assert-JournalTrust $directory
 $source=Join-Path $directory 'payload-probe'
 [IO.File]::WriteAllText($source,'protected payload')
 $hash=(Get-FileHash $source -Algorithm SHA256).Hash
 $target=Join-Path $Destination 'probe.exe'
 Install-StagedFile $source $target $hash
 if([IO.File]::ReadAllText($target) -ne 'protected payload'){throw 'Atomic transfer failed'}
 $acl=Get-Acl -LiteralPath $target
 $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $allowed=@($acl.Access | Where-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $user -and $_.AccessControlType -eq 'Allow'})
 if(!$allowed.Count){throw 'Transferred app file did not inherit the normal user access'}
 $bad=Get-Acl $directory
 $original=Get-Acl $directory
 $bad.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($user)),[Security.AccessControl.FileSystemRights]::Write,[Security.AccessControl.AccessControlType]::Allow)))
 Set-Acl $directory $bad
 $failed=$false;try {Assert-JournalTrust $directory} catch {$failed=$true}
 Set-Acl $directory $original
 if(!$failed){throw 'Writable protected journal was accepted'}
 Remove-Item $target
 [IO.Directory]::Delete($Destination,$false);[IO.Directory]::Delete($case,$false);[IO.Directory]::Delete($directory,$false)
 Write-Output 'PROTECTED_STORAGE_AND_TRANSFER_PERMISSIONS_PASSED'
} catch { throw }
