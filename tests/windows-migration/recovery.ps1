$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\..\build\windows-migration.ps1" -Action Library
function Assert-True($Condition,[string]$Message) { if (!$Condition) { throw $Message } }
$originalPathCheck=${function:Assert-LocalPath}
$productionSave=${function:Save-Journal}
$productionCopy=${function:Copy-DurableFile}
$productionInstall=${function:Install-StagedFile}
$script:failures=@()
function Test-Case([string]$Name,[scriptblock]$Body) {
  try { & $Body; Write-Output "PASS $Name" } catch { $script:failures += "$Name : $($_.Exception.Message)"; Write-Output "FAIL $Name : $($_.Exception.Message)" }
}
function Assert-Fails([scriptblock]$Body,[string]$Message) {
  $failed=$false; try { & $Body } catch { $failed=$true }
  Assert-True $failed $Message
}
$fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('jiwo-recovery-test-'+[Guid]::NewGuid())
$null=New-Item -ItemType Directory -Path $fixtureRoot
# Only Windows/COM/registry boundaries are substituted. File copies, hashes, journals,
# atomic replacements, ownership validation and recovery run production code.
function Assert-LocalPath([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path)
  if (!$full.StartsWith($fixtureRoot+[IO.Path]::DirectorySeparatorChar)) { throw 'Fixture path escaped its private root.' }
  if ([Environment]::OSVersion.Platform -eq 'Win32NT') { return (& $originalPathCheck $Path) }
  $cursor=$full
  while ($cursor -and $cursor.StartsWith($fixtureRoot)) {
    if (([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) -and ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint)) { throw 'Fixture contains a link.' }
    $cursor=[IO.Path]::GetDirectoryName($cursor)
  }
  return $full
}
function Assert-JournalTrust([string]$Directory) { $null=Assert-LocalPath $Directory }
function Assert-ProtectedObject([string]$Path,[bool]$Ancestor) { $null=Assert-LocalPath $Path }
function Assert-Publisher([string]$File) { $null=Assert-LocalPath $File; if (!(Test-Path -LiteralPath $File -PathType Leaf)) { throw 'Missing fixture executable.' } }
function Assert-ElectronDestination { return $script:hadExisting }
function Get-ShortcutLocations { return @([pscustomobject]@{Path=(Join-Path $script:caseRoot 'desktop.lnk');Role='Desktop';Canonical=$true}) }
function Read-ManagedShortcut([string]$Path) {
  $null=Assert-LocalPath $Path
  if (!(Test-Path -LiteralPath $Path)) { return [pscustomobject]@{Exists=$false;Target='';Arguments=''} }
  return (Get-Content -Encoding UTF8 -LiteralPath $Path -Raw | ConvertFrom-Json)
}
function Get-RegistrySnapshots($Legacy) {
  foreach ($key in $ElectronKeys) { [pscustomobject]@{Hive=$(if($Scope -eq 'all'){'LocalMachine'}else{'CurrentUser'});View='Registry64';Path=$key;Node=$script:registry[$key]} }
  if ($Legacy) { [pscustomobject]@{Hive=[string]$Legacy.Hive;View=[string]$Legacy.View;Path=$LegacyKey;Node=$script:registry[$LegacyKey]} }
}
# These boundaries normally read Windows identity, registry and actual COM links.
function Assert-LegacyScope($Install,[string]$Target,[string]$TargetScope) {
  $expected=if ($Install.Scope -eq 'all') {'LocalMachine'} else {'CurrentUser'}
  if ([string]$Install.Hive -ne $expected) { throw 'Invalid legacy registry identity.' }
}
function Assert-LegacyUninstaller([string]$File) { $null=Assert-LocalPath $File }
function Get-LegacyShortcutCandidates($Install) { return @($script:externalLegacyLinks) }
function Get-LegacyShortcuts($Install) { return @($script:externalLegacyLinks) }
function Read-RegistrySnapshot($Snapshot) { return $script:registry[$Snapshot.Path] }
function Write-RegistrySnapshot($Snapshot) { $script:registry[$Snapshot.Path]=$Snapshot.Node }
function New-Value([string]$Name,$Value,[string]$Kind='String') { [pscustomobject]@{Name=$Name;Kind=$Kind;Value=$Value} }
function New-Node($Values=@(),$Children=@()) { [pscustomobject]@{Values=@($Values);Children=@($Children)} }
function New-Fixture {
  $script:externalLegacyLinks=@()
  $script:hadExisting=$true
  $script:caseRoot=Join-Path $fixtureRoot ([Guid]::NewGuid().ToString())
  $script:Destination=Join-Path $script:caseRoot 'installed'; $script:Scope='current'
  $script:Stage=Join-Path $script:caseRoot 'stage'; $script:Manifest=Join-Path $script:caseRoot 'manifest.json'
  $null=New-Item -ItemType Directory -Path $script:Destination,$script:Stage -Force
  [IO.File]::WriteAllText((Join-Path $Destination 'arkme.exe'),'old executable')
  [IO.File]::WriteAllText((Join-Path $Destination 'unknown.db'),'precious local data')
  [IO.File]::WriteAllText((Join-Path $Stage 'arkme.exe'),'new executable')
  [IO.File]::WriteAllText((Join-Path $Stage 'created.dll'),'new library')
  [IO.File]::WriteAllText((Join-Path $Stage 'Uninstall arkme.exe'),'new uninstaller')
  $files=@('arkme.exe','created.dll' | ForEach-Object { $p=Join-Path $Stage $_; @{path=$_;size=(Get-Item -LiteralPath $p).Length;sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()} })
  @{version='3.0.0';versionCode=277;registryMetadata=@{displayName='即我 3.0.0';publisher='Jotmo';description='Desktop client'};files=$files} | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $Manifest
  @{Exists=$true;Target=(Join-Path $Destination 'arkme.exe');Arguments=''} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $script:caseRoot 'desktop.lnk')
  $script:registry=@{}
  $script:registry[$ElectronKeys[0]]=New-Node @((New-Value 'InstallLocation' $Destination),(New-Value 'ShortcutName' 'arkme'))
  $script:registry[$ElectronKeys[1]]=New-Node @((New-Value 'DisplayVersion' '0.3.0'),(New-Value 'JiwoVersionCode' 10 'DWord'))
  $script:registry[$ElectronKeys[2]]=New-Node @((New-Value '' 'Arkme protocol'))
}
function Start-Fixture { New-Fixture; Begin-Overlay $Stage 'Uninstall arkme.exe' $null }
function Read-Installed { [IO.File]::ReadAllText((Join-Path $Destination 'arkme.exe')) }
function Use-LaterManifest {
  @{version='3.1.0';versionCode=278;files=@(@{path='different.exe'},@{path='different.dll'})} | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $Manifest
}
function New-LegacyFixture {
  $root=Join-Path $script:caseRoot 'flutter'
  $null=New-Item -ItemType Directory -Path (Join-Path $root 'data/flutter_assets') -Force
  foreach ($name in @('jotmo.exe','unins000.exe','flutter_windows.dll')) { [IO.File]::WriteAllText((Join-Path $root $name),'signed fixture') }
  $script:registry[$LegacyKey]=New-Node @((New-Value 'InstallLocation' $root),(New-Value 'DisplayVersion' '2.0.0'))
  return [pscustomobject]@{Root=$root;Scope='current';Version='2.0.0';Hive='CurrentUser';View='Registry64'}
}
try {
  $Destination=Join-Path $fixtureRoot 'installed'
  $null=New-Item -ItemType Directory -Path (Join-Path $Destination '.jiwo-v3-transaction') -Force
  $journal=[pscustomobject]@{State='preparing';Message='original'}
  Save-Journal $journal
  foreach ($state in @('active','committed')) {
    $journal.State=$state
    Save-Journal $journal
    $saved=Get-Content -Encoding UTF8 -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw | ConvertFrom-Json
    Assert-True ($saved.State -eq $state) 'successive journal transitions must atomically replace the previous state'
  }
  Assert-True (!(Test-Path -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.pending'))) 'a complete journal update must consume the pending file'

  # Recreate the durable bytes at the first-save move boundary, then interrupt
  # Begin-Overlay before any backup, payload or application mutation can run.
  function New-PendingFixture {
    New-Fixture
    function Save-Journal($Journal) {
      & $productionSave $Journal
      [IO.File]::Move((Join-Path (Get-JournalDirectory) 'journal.json'),(Join-Path (Get-JournalDirectory) 'journal.pending'))
      throw 'Injected first journal promotion interruption'
    }
    Assert-Fails { Begin-Overlay $Stage 'Uninstall arkme.exe' $null } 'initial save must interrupt overlay'
    Assert-True ((Read-Installed) -eq 'old executable') 'initial save precedes live writes'
  }
  Test-Case 'a complete initial pending journal recovers without the incoming manifest' {
    New-PendingFixture; Use-LaterManifest
    Recover-Overlay; Recover-Overlay
    Assert-True ((Read-Installed) -eq 'old executable') 'initial interruption must preserve original executable'
    Assert-True ([IO.File]::ReadAllText((Join-Path $Destination 'unknown.db')) -eq 'precious local data') 'unknown data remains intact'
    Assert-True (!(Test-Path -LiteralPath (Get-JournalDirectory))) 'owned first-write interruption cannot permanently block retry'
  }
  Test-Case 'a second interruption after pending promotion is recoverable' {
    New-PendingFixture
    function Remove-Item([string]$LiteralPath,[switch]$Force) {
      if ($LiteralPath.EndsWith('journal.json')) { throw 'Injected interruption after promotion' }
      Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Force:$Force
    }
    Assert-Fails { Recover-Overlay } 'cleanup injection must interrupt recovery'
    Assert-True (Test-Path -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json')) 'promotion must retain durable preparing metadata until cleanup'
    Microsoft.PowerShell.Management\Remove-Item Function:Remove-Item
    Recover-Overlay; Recover-Overlay
    Assert-True (!(Test-Path -LiteralPath (Get-JournalDirectory))) 'repeated recovery finishes promoted record'
  }
  $pendingDamageCases=@('malformed','active','committed','wrong-destination','wrong-source','wrong-registry','unknown-neighbor','directory')
  # Windows symlink creation requires privileges that these filesystem fixtures do not request.
  if ([Environment]::OSVersion.Platform -ne 'Win32NT') { $pendingDamageCases+=@('symlink') }
  foreach ($damage in $pendingDamageCases) {
    Test-Case "untrusted initial pending is preserved: $damage" {
      New-PendingFixture
      $pending=Join-Path (Get-JournalDirectory) 'journal.pending'
      $saved=Get-Content -LiteralPath $pending -Raw -Encoding UTF8 | ConvertFrom-Json
      switch ($damage) {
        'malformed' { [IO.File]::WriteAllText($pending,'{"Schema":2,') }
        'active' { $saved.State='active' }
        'committed' { $saved.State='committed' }
        'wrong-destination' { $saved.Destination=Join-Path $caseRoot 'other' }
        'wrong-source' { [IO.File]::WriteAllText((Join-Path $Destination 'arkme.exe'),'unknown replacement') }
        'wrong-registry' { $script:registry[$ElectronKeys[1]]=New-Node @((New-Value 'DisplayVersion' '9.0.0')) }
        'unknown-neighbor' { [IO.File]::WriteAllText((Join-Path (Get-JournalDirectory) 'foreign.db'),'precious') }
        'directory' { Remove-Item -LiteralPath $pending; $null=New-Item -ItemType Directory -Path $pending }
        'symlink' {
          $witness=Join-Path $caseRoot 'foreign.json'; [IO.File]::Move($pending,$witness)
          $null=New-Item -ItemType SymbolicLink -Path $pending -Target $witness
        }
      }
      if ($damage -in @('active','committed','wrong-destination')) { $saved | ConvertTo-Json -Depth 64 | Set-Content -LiteralPath $pending -Encoding UTF8 }
      $before=Read-Installed
      Assert-Fails { Recover-Overlay } 'ambiguous initial pending must fail closed'
      Assert-True (Test-Path -LiteralPath $pending) 'untrusted pending object must not be deleted'
      Assert-True (!(Test-Path -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json'))) 'untrusted pending must not be promoted'
      Assert-True ((Read-Installed) -eq $before) 'validation failure must leave application unchanged'
    }
  }

  Test-Case 'a later EXE recovers an active older transaction using saved hashes' {
    Start-Fixture; Use-LaterManifest; Recover-Overlay
    Assert-True ((Read-Installed) -eq 'old executable') 'previous bytes must be restored'
    Assert-True (!(Test-Path -LiteralPath (Join-Path $Destination 'created.dll'))) 'only transaction-created files are removed'
    Assert-True ([IO.File]::ReadAllText((Join-Path $Destination 'unknown.db')) -eq 'precious local data') 'local data stays unchanged'
    Assert-True (!(Test-Path -LiteralPath (Get-JournalDirectory))) 'completed recovery cleans its own record'
    Recover-Overlay
  }
  Test-Case 'unknown replacement at a later file prevents every restoration' {
    Start-Fixture
    [IO.File]::WriteAllText((Join-Path $Destination 'created.dll'),'unknown replacement')
    Assert-Fails { Recover-Overlay } 'unknown live bytes must abort'
    Assert-True ((Read-Installed) -eq 'new executable') 'first known file must not be restored before later validation'
    Assert-True ([IO.File]::ReadAllText((Join-Path $Destination 'created.dll')) -eq 'unknown replacement') 'unknown replacement must remain'
  }
  Test-Case 'newer registration prevents rollback even when executable bytes are unchanged' {
    Start-Fixture
    $script:registry[$ElectronKeys[1]]=New-Node @((New-Value 'DisplayVersion' '4.0.0'),(New-Value 'JiwoVersionCode' 500 'DWord'))
    Assert-Fails { Recover-Overlay } 'newer registration must abort before restoration'
    Assert-True ((Read-Installed) -eq 'new executable') 'later registration must not cause an implicit downgrade'
  }
  Test-Case 'unknown shortcut prevents any program file restoration' {
    Start-Fixture
    @{Exists=$true;Target='unrelated.exe';Arguments='--unknown'} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $script:caseRoot 'desktop.lnk')
    Assert-Fails { Recover-Overlay } 'unknown shortcut must abort'
    Assert-True ((Read-Installed) -eq 'new executable') 'program files stay unchanged if any shortcut is unknown'
  }
  Test-Case 'unknown registry children prevent every restoration' {
    Start-Fixture
    $script:registry[$ElectronKeys[0]]=New-Node @() @([pscustomobject]@{Name='Foreign';Node=(New-Node @((New-Value 'data' 'precious')))})
    Assert-Fails { Recover-Overlay } 'unknown registry children must abort'
    Assert-True ((Read-Installed) -eq 'new executable') 'registry validation precedes file changes'
  }
  Test-Case 'known partial NSIS registration can be restored' {
    Start-Fixture
    $script:registry[$ElectronKeys[0]]=New-Node @((New-Value 'InstallLocation' $Destination),(New-Value 'ShortcutName' '即我'),(New-Value 'KeepShortcuts' 'true'))
    $script:registry[$ElectronKeys[1]]=New-Node @((New-Value 'DisplayVersion' '3.0.0'),(New-Value 'DisplayName' '即我 3.0.0'),(New-Value 'JiwoVersionCode' 277 'DWord'))
    Recover-Overlay
    Assert-True ((Read-Installed) -eq 'old executable') 'known partial registry writes allow rollback'
    Assert-True (@($script:registry[$ElectronKeys[1]].Values | Where-Object { $_.Name -eq 'DisplayVersion' })[0].Value -eq '0.3.0') 'old registry values are restored'
  }
  Test-Case 'unknown journal file is detected before restoring the program' {
    Start-Fixture
    [IO.File]::WriteAllText((Join-Path (Get-JournalDirectory) 'foreign.db'),'precious journal neighbor')
    Assert-Fails { Recover-Overlay } 'unknown journal files must abort'
    Assert-True ((Read-Installed) -eq 'new executable') 'unknown journal file must not leave a partial rollback'
  }
  Test-Case 'empty terminal cleanup directory can be removed repeatedly' {
    New-Fixture
    $null=New-Item -ItemType Directory -Path (Get-JournalDirectory)
    Recover-Overlay; Recover-Overlay
    Assert-True (!(Test-Path -LiteralPath (Get-JournalDirectory))) 'empty terminal directory should not permanently block install'
  }
  Test-Case 'unidentified nonempty directory stays intact' {
    New-Fixture
    $null=New-Item -ItemType Directory -Path (Get-JournalDirectory)
    [IO.File]::WriteAllText((Join-Path (Get-JournalDirectory) 'foreign.db'),'precious data')
    Assert-Fails { Recover-Overlay } 'nonempty directory without metadata must abort'
    Assert-True ([IO.File]::ReadAllText((Join-Path (Get-JournalDirectory) 'foreign.db')) -eq 'precious data') 'unknown data is retained'
  }
  Test-Case 'committed cleanup accepts later installed bytes without changing them' {
    Start-Fixture; Complete-Overlay; Use-LaterManifest
    [IO.File]::WriteAllText((Join-Path $Destination 'arkme.exe'),'later executable')
    Recover-Overlay
    Assert-True ((Read-Installed) -eq 'later executable') 'committed cleanup cannot revert a later installed release'
    Assert-True (!(Test-Path -LiteralPath (Get-JournalDirectory))) 'committed backups are cleaned'
  }
  Test-Case 'journal registry scope cannot escape current-user installation' {
    Start-Fixture
    $saved=Get-Content -Encoding UTF8 -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw | ConvertFrom-Json
    $saved.Registry[0].Hive='LocalMachine'; Save-Journal $saved
    Assert-Fails { Recover-Overlay } 'mismatched registry hive must abort'
    Assert-True ((Read-Installed) -eq 'new executable') 'invalid metadata causes no restoration'
  }
  Test-Case 'interrupted payload staging leaves live files intact and a later EXE can retry' {
    New-Fixture
    function Copy-DurableFile([string]$Source,[string]$Target) {
      if ($Target.EndsWith('payload-1')) { [IO.File]::WriteAllText($Target,'new'); throw 'Injected interrupted staging copy' }
      & $productionCopy $Source $Target
    }
    Assert-Fails { Begin-Overlay $Stage 'Uninstall arkme.exe' $null } 'interrupted staging must fail'
    Assert-True ((Read-Installed) -eq 'old executable') 'a partial payload copy must not damage the live file'
    Use-LaterManifest; Recover-Overlay
    Assert-True ((Read-Installed) -eq 'old executable') 'retry must preserve the untouched original'
    Assert-True (!(Test-Path -LiteralPath (Get-JournalDirectory))) 'partial staging must be cleanable'
  }
  Test-Case 'interrupted overlay between atomic replacements is repeatably recoverable' {
    New-Fixture
    function Install-StagedFile([string]$Source,[string]$Target,[string]$Hash) {
      if ($Source.EndsWith('payload-1')) { throw 'Injected interruption before atomic move' }
      & $productionInstall $Source $Target $Hash
    }
    Assert-Fails { Begin-Overlay $Stage 'Uninstall arkme.exe' $null } 'overlay interruption must leave a recovery record'
    Assert-True ((Read-Installed) -eq 'new executable') 'first target must contain complete new bytes'
    Assert-True (!(Test-Path -LiteralPath (Join-Path $Destination 'created.dll'))) 'second target must remain absent, never partially copied'
    Use-LaterManifest; Recover-Overlay; Recover-Overlay
    Assert-True ((Read-Installed) -eq 'old executable') 'mixed original/new transaction bytes must restore'
  }
  Test-Case 'interrupted rollback copy keeps live bytes valid and a second recovery succeeds' {
    Start-Fixture
    $script:injected=$false
    function Copy-DurableFile([string]$Source,[string]$Target) {
      if ($Target.EndsWith('restore-0') -and !$script:injected) { $script:injected=$true; [IO.File]::WriteAllText($Target,'old'); throw 'Injected interrupted restoration copy' }
      & $productionCopy $Source $Target
    }
    Assert-Fails { Recover-Overlay } 'interrupted restoration must keep the journal'
    Assert-True ((Read-Installed) -eq 'new executable') 'interrupted backup copy must not truncate the live executable'
    Recover-Overlay; Recover-Overlay
    Assert-True ((Read-Installed) -eq 'old executable') 'a second recovery must resume safely'
  }
  Test-Case 'tampered restoration scratch is preserved before any rollback' {
    Start-Fixture
    [IO.File]::WriteAllText((Join-Path (Get-JournalDirectory) 'restore-0'),'alien')
    Assert-Fails { Recover-Overlay } 'a scratch file unrelated to the verified backup must abort'
    Assert-True ((Read-Installed) -eq 'new executable') 'unknown scratch cannot trigger partial restoration'
  }
  Test-Case 'tampered committed backup prevents cleanup' {
    Start-Fixture; Complete-Overlay
    [IO.File]::WriteAllText((Join-Path (Get-JournalDirectory) 'file-0'),'alien backup')
    Assert-Fails { Recover-Overlay } 'unknown committed backups must be preserved'
    Assert-True ([IO.File]::ReadAllText((Join-Path (Get-JournalDirectory) 'file-0')) -eq 'alien backup') 'cleanup may not delete an unknown replacement'
  }
  Test-Case 'a clean installation can roll back partial new registration' {
    New-Fixture; $script:hadExisting=$false
    Remove-Item -LiteralPath (Join-Path $Destination 'arkme.exe'),(Join-Path $script:caseRoot 'desktop.lnk')
    foreach ($key in $ElectronKeys) { $script:registry[$key]=$null }
    Begin-Overlay $Stage 'Uninstall arkme.exe' $null
    $script:registry[$ElectronKeys[0]]=New-Node @((New-Value 'InstallLocation' $Destination),(New-Value 'ShortcutName' '即我'))
    $script:registry[$ElectronKeys[1]]=New-Node @((New-Value 'DisplayVersion' '3.0.0'),(New-Value 'JiwoVersionCode' 277 'DWord'))
    Recover-Overlay
    Assert-True (!(Test-Path -LiteralPath (Join-Path $Destination 'arkme.exe'))) 'failed clean install leaves no partial application'
    Assert-True ($null -eq $script:registry[$ElectronKeys[1]]) 'new registration must be removed on clean-install rollback'
    Assert-True ([IO.File]::ReadAllText((Join-Path $Destination 'unknown.db')) -eq 'precious local data') 'clean rollback cannot remove unknown data'
  }
  Test-Case 'a second interruption while cleaning partial backups remains recoverable' {
    New-Fixture
    function Copy-DurableFile([string]$Source,[string]$Target) {
      if ($Target.EndsWith('file-0')) { [IO.File]::WriteAllText($Target,'old'); throw 'Injected interrupted backup copy' }
      & $productionCopy $Source $Target
    }
    Assert-Fails { Begin-Overlay $Stage 'Uninstall arkme.exe' $null } 'partial backup must retain preparing state'
    $script:interruptedCleanup=$false
    function Remove-Item([string]$LiteralPath,[switch]$Force) {
      if ($LiteralPath.EndsWith('file-0') -and !$script:interruptedCleanup) { $script:interruptedCleanup=$true; throw 'Injected cleanup interruption' }
      Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Force:$Force
    }
    Assert-Fails { Recover-Overlay } 'cleanup interruption must preserve the record'
    Recover-Overlay
    Assert-True ((Read-Installed) -eq 'old executable') 'repeated partial-backup cleanup preserves the original'
    Assert-True (!(Test-Path -LiteralPath (Get-JournalDirectory))) 'retry can finish cleanup after a second interruption'
  }
  Test-Case 'a signed Flutter launcher build cannot be downgraded by a higher semantic version' {
    New-Fixture
    $legacyRoot=Join-Path $script:caseRoot 'flutter'
    $null=New-Item -ItemType Directory -Path (Join-Path $legacyRoot 'data/flutter_assets') -Force
    foreach ($name in @('jotmo.exe','unins000.exe','flutter_windows.dll')) { [IO.File]::WriteAllText((Join-Path $legacyRoot $name),'signed fixture') }
    $legacy=[pscustomobject]@{Root=$legacyRoot;Scope='current';Version='2.0.0'}
    function Get-LegacyVersionCode([string]$Launcher) { return 400L }
    Assert-Fails { Assert-Legacy $legacy $Destination 'current' } 'a known higher signed PE build must abort migration'
    Assert-True ([IO.File]::ReadAllText((Join-Path $legacyRoot 'jotmo.exe')) -eq 'signed fixture') 'rejected migration preserves the legacy launcher'
  }
  Test-Case 'interrupted legacy retirement is restored together with owned registration' {
    New-Fixture; $legacy=New-LegacyFixture
    Begin-Overlay $Stage 'Uninstall arkme.exe' $legacy
    foreach ($name in @('jotmo.exe','unins000.exe')) { $p=Join-Path $legacy.Root $name; Move-Item -LiteralPath $p -Destination ($p+$RetiredSuffix) }
    $script:registry[$LegacyKey]=$null
    Use-LaterManifest; Recover-Overlay
    Assert-True ((Read-Installed) -eq 'old executable') 'program overlay rolls back'
    Assert-True ([IO.File]::ReadAllText((Join-Path $legacy.Root 'jotmo.exe')) -eq 'signed fixture') 'legacy launcher returns to original name'
    Assert-True ($null -ne $script:registry[$LegacyKey]) 'deleted Inno key is restored'
  }
  Test-Case 'unknown legacy retirement bytes prevent any new-program rollback' {
    New-Fixture; $legacy=New-LegacyFixture
    Begin-Overlay $Stage 'Uninstall arkme.exe' $legacy
    $p=Join-Path $legacy.Root 'unins000.exe'; Move-Item -LiteralPath $p -Destination ($p+$RetiredSuffix)
    [IO.File]::WriteAllText(($p+$RetiredSuffix),'unknown retired bytes')
    Assert-Fails { Recover-Overlay } 'unknown legacy backup must abort'
    Assert-True ((Read-Installed) -eq 'new executable') 'validate legacy before restoring even the first manifest file'
    Assert-True ([IO.File]::ReadAllText(($p+$RetiredSuffix)) -eq 'unknown retired bytes') 'unknown retired object stays intact'
  }
  Test-Case 'malformed saved registry children abort before any restoration' {
    Start-Fixture
    $saved=Get-Content -Encoding UTF8 -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw | ConvertFrom-Json
    $saved.Registry[1].Node.Children=@([pscustomobject]@{Name='invalid\child';Node=(New-Node)})
    Save-Journal $saved
    Assert-Fails { Recover-Overlay } 'invalid serialized registry structure must fail before invoking any restore'
    Assert-True ((Read-Installed) -eq 'new executable') 'corrupt metadata must preserve the current executable'
  }
  Test-Case 'an originally absent startup entry cannot become transaction-owned during recovery' {
    New-Fixture
    function Get-ShortcutLocations { return @([pscustomobject]@{Path=(Join-Path $script:caseRoot 'startup.lnk');Role='Startup';Canonical=$true}) }
    Begin-Overlay $Stage 'Uninstall arkme.exe' $null
    @{Exists=$true;Target=(Join-Path $Destination 'arkme.exe');Arguments=''} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $script:caseRoot 'startup.lnk')
    Assert-Fails { Recover-Overlay } 'installer never enables absent startup, so a new entry is not owned'
    Assert-True ((Read-Installed) -eq 'new executable') 'an unrelated startup change must prevent partial rollback'
    Assert-True (Test-Path -LiteralPath (Join-Path $script:caseRoot 'startup.lnk')) 'external startup entry stays intact'
  }
  Test-Case 'machine Flutter with user Arkme restores both hives and external shortcuts after interruption' {
    New-Fixture; $legacy=New-LegacyFixture
    $legacy.Scope='all'; $legacy.Hive='LocalMachine'
    $link=Join-Path $script:caseRoot 'public-desktop.lnk'
    [IO.File]::WriteAllText($link,'original public shortcut')
    $script:externalLegacyLinks=@($link)
    Begin-Overlay $Stage 'Uninstall arkme.exe' $legacy
    $saved=Get-Content -Encoding UTF8 -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw | ConvertFrom-Json
    Assert-True (@($saved.Registry | Where-Object {$_.Hive -eq 'LocalMachine' -and $_.Path -eq $LegacyKey}).Count -eq 1) 'legacy snapshot must retain original HKLM hive'
    Assert-True (@($saved.LegacyFiles | Where-Object {$_.Path -eq $link}).Count -eq 1) 'external shortcut must be transaction-owned'
    foreach ($entry in $saved.LegacyFiles) { Move-Item -LiteralPath $entry.Path -Destination ($entry.Path+$RetiredSuffix) }
    $script:registry[$LegacyKey]=$null
    Recover-Overlay
    Assert-True ((Read-Installed) -eq 'old executable') 'existing per-user Arkme restored'
    Assert-True ([IO.File]::ReadAllText($link) -eq 'original public shortcut') 'original public shortcut restored'
    Assert-True ($null -ne $script:registry[$LegacyKey]) 'legacy machine registration restored'
    Recover-Overlay
    Assert-True (!(Test-Path -LiteralPath (Get-JournalDirectory))) 'second recovery remains idempotent'
  }
  Test-Case 'mixed-scope recovery rejects a registry snapshot pointed at another hive' {
    New-Fixture; $legacy=New-LegacyFixture; $legacy.Scope='all'; $legacy.Hive='LocalMachine'
    Begin-Overlay $Stage 'Uninstall arkme.exe' $legacy
    $saved=Get-Content -Encoding UTF8 -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw | ConvertFrom-Json
    $saved.Registry[0].Hive='LocalMachine'; Save-Journal $saved
    Assert-Fails { Recover-Overlay } 'only legacy Inno key can belong to the other hive'
    Assert-True ((Read-Installed) -eq 'new executable') 'invalid scene must stop before restoration'
  }
  Test-Case 'user Flutter with machine Arkme restores original hives and files' {
    New-Fixture; $script:Scope='all'; $legacy=New-LegacyFixture
    Begin-Overlay $Stage 'Uninstall arkme.exe' $legacy
    $saved=Get-Content -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True (@($saved.Registry | Where-Object {$_.Hive -eq 'CurrentUser' -and $_.Path -eq $LegacyKey}).Count -eq 1) 'Flutter user registry captured'
    Assert-True (@($saved.Registry | Where-Object {$_.Hive -eq 'LocalMachine' -and $_.Path -eq $ElectronKeys[0]}).Count -eq 1) 'Arkme machine registry captured'
    foreach($entry in $saved.LegacyFiles){Move-Item -LiteralPath $entry.Path -Destination ($entry.Path+$RetiredSuffix)}
    $script:registry[$LegacyKey]=$null
    Recover-Overlay
    Assert-True ((Read-Installed) -eq 'old executable') 'all-user Arkme restored'
    Assert-True ($null -ne $script:registry[$LegacyKey]) 'current-user Flutter registry restored'
    Recover-Overlay
  }
  Test-Case 'interrupted adjacent transfer is verified before rollback' {
    Start-Fixture
    $saved=Get-Content -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $entry=$saved.Files[0];$target=Join-Path $Destination $entry.Path
    $scratch=Get-TransferPath $target $entry.Hash
    [IO.File]::WriteAllText($scratch,'unknown bytes')
    Assert-Fails {Recover-Overlay} 'unknown adjacent transfer must stop rollback before mutation'
    Assert-True ((Read-Installed) -eq 'new executable') 'unknown scratch prevents any rollback'
    Remove-Item $scratch
    [IO.File]::WriteAllText($scratch,'old')
    Recover-Overlay
    Assert-True ((Read-Installed) -eq 'old executable') 'known partial transfer can recover'
    Assert-True (!(Test-Path $scratch)) 'successful recovery cleans adjacent scratch'
  }
  Test-Case 'identical old and new file hashes still recover a partial transfer' {
    New-Fixture
    [IO.File]::WriteAllText((Join-Path $Destination 'created.dll'),'new library')
    Begin-Overlay $Stage 'Uninstall arkme.exe' $null
    $saved=Get-Content -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $entry=@($saved.Files | Where-Object {$_.Path -eq 'created.dll'})[0]
    $scratch=Get-TransferPath (Join-Path $Destination $entry.Path) $entry.Hash
    [IO.File]::WriteAllText($scratch,'new')
    Recover-Overlay
    Assert-True ((Read-Installed) -eq 'old executable') 'same-hash transfer must not block rollback'
    Assert-True (!(Test-Path $scratch)) 'same-hash scratch cleaned'
  }
  Test-Case 'committed migration cleans its retired launchers before removing the journal' {
    New-Fixture; $legacy=New-LegacyFixture
    Begin-Overlay $Stage 'Uninstall arkme.exe' $legacy
    $saved=Get-Content -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach($entry in $saved.LegacyFiles){Move-Item -LiteralPath $entry.Path -Destination ($entry.Path+$RetiredSuffix)}
    $script:registry[$LegacyKey]=$null
    Complete-Overlay
    Recover-Overlay
    foreach($entry in $saved.LegacyFiles){Assert-True (!(Test-Path ($entry.Path+$RetiredSuffix))) 'successful migration must not leave retirement blockers'}
  }
  Test-Case 'unknown committed retirement keeps the journal and all other retirements' {
    New-Fixture; $legacy=New-LegacyFixture
    Begin-Overlay $Stage 'Uninstall arkme.exe' $legacy
    $saved=Get-Content -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach($entry in $saved.LegacyFiles){Move-Item -LiteralPath $entry.Path -Destination ($entry.Path+$RetiredSuffix)}
    $script:registry[$LegacyKey]=$null
    Complete-Overlay
    [IO.File]::WriteAllText(($saved.LegacyFiles[1].Path+$RetiredSuffix),'unknown bytes')
    Assert-Fails {Recover-Overlay} 'unknown committed retirement must stop cleanup'
    Assert-True (Test-Path (Join-Path (Get-JournalDirectory) 'journal.json')) 'keep ownership record when cleanup cannot finish'
    Assert-True (Test-Path ($saved.LegacyFiles[0].Path+$RetiredSuffix)) 'validate whole retirement set before deleting any'
  }
  Test-Case 'partial committed cleanup preserves subsequently reinstalled Flutter' {
    New-Fixture; $legacy=New-LegacyFixture
    Begin-Overlay $Stage 'Uninstall arkme.exe' $legacy
    $saved=Get-Content -LiteralPath (Join-Path (Get-JournalDirectory) 'journal.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach($entry in $saved.LegacyFiles){Move-Item -LiteralPath $entry.Path -Destination ($entry.Path+$RetiredSuffix)}
    $script:registry[$LegacyKey]=$null
    Complete-Overlay
    Remove-Item -LiteralPath ($saved.LegacyFiles[0].Path+$RetiredSuffix)
    [IO.File]::WriteAllText($saved.LegacyFiles[0].Path,'reinstalled Flutter')
    Recover-Overlay
    Assert-True (([IO.File]::ReadAllText($saved.LegacyFiles[0].Path)) -eq 'reinstalled Flutter') 'cleanup must not touch a reinstalled active path'
    foreach($entry in $saved.LegacyFiles){Assert-True (!(Test-Path ($entry.Path+$RetiredSuffix))) 'cleanup resumes after a prior retirement was removed'}
  }
  if ($script:failures.Count) { throw ($script:failures -join "`n") }
  Write-Output 'Durable recovery fixtures passed.'
} finally {
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
