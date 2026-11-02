# Elevated Windows integration fixture. Only uniquely named test files are created.
param([string]$MigrationScript="$PSScriptRoot\..\..\build\windows-migration.ps1",[switch]$ExpectBaselineFailure)
$ErrorActionPreference='Stop'
. $MigrationScript -Action Library
function Assert-True($Value,[string]$Message) { if (!$Value) { throw $Message } }
$fixtureId='JiwoShortcutAcl-'+[guid]::NewGuid().ToString('N')
$fixtureRoot=Join-Path $env:ProgramFiles $fixtureId
$stageRoot=Join-Path ([IO.Path]::GetTempPath()) $fixtureId
$Scope='all'
# Redirect discovery to nonexistent test registry keys and test-owned shortcuts.
# All signature, payload, ACL, COM, journal, file replacement and recovery code is real.
$ElectronKeys=@("SOFTWARE\$fixtureId\App","SOFTWARE\$fixtureId\Uninstall","SOFTWARE\$fixtureId\Protocol")
function Get-ShortcutLocations($Legacy=$null) { [pscustomobject]@{Path=$script:fixtureLink;Role=$script:fixtureRole;Canonical=$true} }
$signature=Get-AuthenticodeSignature (Join-Path $PSHOME 'powershell.exe')
Assert-True ($signature.Status -eq 'Valid') 'Windows signed fixture must validate.'
$Publisher=$signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)
$script:fixtureLink=''
try {
  New-ProtectedDirectory $fixtureRoot
  $null=New-Item -ItemType Directory $stageRoot
  foreach($name in @('arkme.exe','Uninstall arkme.exe')) {Copy-Item (Join-Path $PSHOME 'powershell.exe') (Join-Path $stageRoot $name)}
  [IO.File]::WriteAllText((Join-Path $stageRoot 'app.asar'),'fixture asset')
  $Manifest=Join-Path $stageRoot 'manifest.json'
  $files=@('arkme.exe','app.asar') | ForEach-Object {@{path=$_;sha256=(Get-FileHash (Join-Path $stageRoot $_) -Algorithm SHA256).Hash.ToLowerInvariant();size=(Get-Item (Join-Path $stageRoot $_)).Length}}
  @{version='3.0.24';versionCode=302;registryMetadata=@{displayName='即我 3.0.24';publisher=$Publisher;description='ACL fixture'};files=@($files)} | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $Manifest
  foreach($folder in @('CommonDesktopDirectory','CommonPrograms')) {
    $Destination=Join-Path $fixtureRoot $folder
    New-ProtectedDirectory $Destination
    $script:fixtureRole=if($folder -eq 'CommonPrograms'){'Programs'}else{'Desktop'}
    $script:fixtureLink=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::$folder)) ($fixtureId+'.lnk')
    Assert-True (!(Test-Path $script:fixtureLink)) 'Fixture shortcut must not already exist.'
    $shell=New-Object -ComObject WScript.Shell
    $link=$shell.CreateShortcut($script:fixtureLink); $link.TargetPath=Join-Path $Destination 'arkme.exe'; $link.Save()
    $originalHash=(Get-FileHash $script:fixtureLink -Algorithm SHA256).Hash
    $originalSddl=(Get-Acl $script:fixtureLink).Sddl
    if (!$ExpectBaselineFailure) {
      $aclBefore=Get-Acl $script:fixtureLink
      $userSid=New-Object Security.Principal.SecurityIdentifier([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
      try {
        foreach($right in @('Delete','DeleteSubdirectoriesAndFiles','Write','ChangePermissions','TakeOwnership')) {
          $acl=Get-Acl $script:fixtureLink
          $acl.SetSecurityDescriptorSddlForm($originalSddl)
          $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($userSid,[Security.AccessControl.FileSystemRights]::$right,[Security.AccessControl.AccessControlType]::Allow)))
          Set-Acl $script:fixtureLink $acl
          $errorMessage='';try {Assert-ProtectedObject $script:fixtureLink $false -AllowShortcutDeletion} catch {$errorMessage=$_.Exception.Message}
          if($right -in @('Delete','DeleteSubdirectoriesAndFiles')) {
            Assert-True (!$errorMessage) "Deletion-only shell permission should pass: $errorMessage"
            $strictRejected=$false;try {Assert-ProtectedObject $script:fixtureLink $false} catch {$strictRejected=$true}
            Assert-True $strictRejected 'Strict payload/recovery ACL checks must not change.'
          } else {Assert-True ($errorMessage -like 'Untrusted write*') "Unsafe shortcut permission must remain blocked: $right"}
        }
        $acl=Get-Acl $script:fixtureLink; $acl.SetSecurityDescriptorSddlForm($originalSddl); $acl.SetOwner($userSid); Set-Acl $script:fixtureLink $acl
        $ownerRejected=$false;try {Assert-ProtectedObject $script:fixtureLink $false -AllowShortcutDeletion} catch {$ownerRejected=$_.Exception.Message -like 'Untrusted owner*'}
        Assert-True $ownerRejected 'Untrusted shortcut owner must remain blocked.'
      } finally {Set-Acl $script:fixtureLink $aclBefore}
      Write-Output "PASS shortcut deletion-only compatibility and unsafe ACL rejection: $folder"
    }
    Write-Output "Shortcut folder=$folder ACL=$originalSddl"
    $message=''
    try { Begin-Overlay $stageRoot 'Uninstall arkme.exe' $null } catch {$message=$_.Exception.Message}
    if($ExpectBaselineFailure) {
      Assert-True ($message -like 'Untrusted write, deletion, or ACL-control permission*') "Baseline did not reproduce ACL failure: $message"
      Assert-True (!(Test-Path (Get-JournalDirectory))) 'Baseline failure should precede journal creation.'
      Assert-True (!(Test-Path (Join-Path $Destination 'arkme.exe'))) 'Baseline failure must not install payload.'
      Write-Output "PASS baseline reproduced ${folder}: $message"
    } else {
      Assert-True (!$message) "Overlay failed: $message"
      Assert-Payload $Destination $Manifest
      $journal=Get-Content (Join-Path (Get-JournalDirectory) 'journal.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      Assert-True ($journal.State -eq 'active') 'Overlay must reach active state.'
      Assert-True ($journal.Shortcuts[0].Hash -eq $originalHash) 'Original link hash must be journaled.'
      Assert-JournalTrust (Get-JournalDirectory)
      # An unrelated target introduced after Apply must be preserved and block rollback.
      $link=$shell.CreateShortcut($script:fixtureLink); $link.TargetPath=Join-Path $PSHOME 'powershell.exe'; $link.Arguments='-NoProfile'; $link.Save()
      $foreignHash=(Get-FileHash $script:fixtureLink -Algorithm SHA256).Hash
      $rejected=$false; try { Recover-Overlay } catch {$rejected=$_.Exception.Message -like '*unknown shortcut*'}
      Assert-True $rejected 'Changed unknown link must block recovery.'
      Assert-True ((Get-FileHash $script:fixtureLink -Algorithm SHA256).Hash -eq $foreignHash) 'Unknown link must remain untouched.'
      # Restore the test-owned original from the protected backup, then exercise rollback.
      Copy-Item (Join-Path (Get-JournalDirectory) 'shortcut-0') $script:fixtureLink -Force
      Recover-Overlay
      Assert-True (!(Test-Path (Get-JournalDirectory))) 'Rollback must remove the completed journal.'
      Assert-True (!(Test-Path (Join-Path $Destination 'arkme.exe'))) 'Rollback must remove newly installed payload.'
      Assert-True ((Get-FileHash $script:fixtureLink -Algorithm SHA256).Hash -eq $originalHash) 'Rollback must restore exact shortcut bytes.'
      Assert-True ((Get-Acl $script:fixtureLink).Sddl -eq $originalSddl) 'Shortcut permissions must remain unchanged.'
      # Unknown shortcuts also remain blocked at the initial planning boundary.
      $link=$shell.CreateShortcut($script:fixtureLink); $link.Arguments='--unknown'; $link.Save()
      $rejected=$false; try { Begin-Overlay $stageRoot 'Uninstall arkme.exe' $null } catch {$rejected=$_.Exception.Message -like 'Shortcut compatibility check failed*'}
      Assert-True $rejected 'Unknown arguments must remain blocked.'
      Assert-True (!(Test-Path (Get-JournalDirectory))) 'Rejected link must not create a transaction.'
      Write-Output "PASS overlay, protected backup, foreign-link preservation and rollback: $folder"
    }
    Remove-Item -LiteralPath $script:fixtureLink -Force
    $script:fixtureLink=''
  }
  Write-Output 'Windows shortcut ACL regression tests passed.'
} finally {
  if($script:fixtureLink -and (Test-Path $script:fixtureLink)) {Remove-Item -LiteralPath $script:fixtureLink -Force}
  foreach($path in @($fixtureRoot,$stageRoot)) {if(Test-Path $path){Remove-Item -LiteralPath $path -Recurse -Force}}
}
