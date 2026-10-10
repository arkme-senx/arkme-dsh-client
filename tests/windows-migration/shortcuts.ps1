$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\..\build\windows-migration.ps1" -Action Library
function Assert-True($Condition,$Message) { if (!$Condition) { throw $Message } }
$new='C:\Apps\arkme\arkme.exe'; $legacy='C:\Apps\jotmo\jotmo.exe'
$read={ param($p) if ($script:links.ContainsKey($p)) { $script:links[$p] } else { [pscustomobject]@{Exists=$false;Target='';Arguments=''} } }
$write={ param($p,$target) $script:links[$p]=[pscustomobject]@{Exists=$true;Target=$target;Arguments=''} }
$remove={ param($p) $script:links.Remove($p) }
function Snapshot($Role,$OldExists,$NewExists) {
  [pscustomobject]@{Path="$Role/arkme.lnk";Role=$Role;Canonical=$false;Existed=$OldExists}
  [pscustomobject]@{Path="$Role/jiwo.lnk";Role=$Role;Canonical=$true;Existed=$NewExists}
}
# Manual update: NSIS created the new link but left the old link behind.
$script:links=@{}
& $write 'Desktop/arkme.lnk' $new; & $write 'Desktop/jiwo.lnk' $new
Invoke-ShortcutReconciliation @(Snapshot Desktop $true $false) $new $legacy $true $read $write $remove
Assert-True (!$links.ContainsKey('Desktop/arkme.lnk')) 'manual update must remove validated old Arkme entry'
Assert-True ($links['Desktop/jiwo.lnk'].Target -eq $new) 'manual update must retain verified new entry'
# Coexistence: builder Rename collided with Flutter's existing canonical filename.
$script:links=@{}
& $write 'Programs/arkme.lnk' $new; & $write 'Programs/jiwo.lnk' $legacy
Invoke-ShortcutReconciliation @(Snapshot Programs $true $true) $new $legacy $true $read $write $remove
Assert-True (!$links.ContainsKey('Programs/arkme.lnk')) 'coexistence must leave only one menu entry'
Assert-True ($links['Programs/jiwo.lnk'].Target -eq $new) 'Flutter menu entry must be replaced before old alias removal'
# An upgrade must preserve previous absence, despite builder recreating a shortcut.
$script:links=@{}; & $write 'Desktop/jiwo.lnk' $new
Invoke-ShortcutReconciliation @(Snapshot Desktop $false $false) $new $legacy $true $read $write $remove
Assert-True (!$links.ContainsKey('Desktop/jiwo.lnk')) 'upgrade must preserve intentionally absent desktop entry'
# Fresh installs retain the default builder-created desktop entry.
$script:links=@{}; & $write 'Desktop/jiwo.lnk' $new
Invoke-ShortcutReconciliation @(Snapshot Desktop $false $false) $new '' $false $read $write $remove
Assert-True ($links.ContainsKey('Desktop/jiwo.lnk')) 'fresh install must retain builder default entry'
# Startup is migrated only when it already existed.
$script:links=@{}; & $write 'Startup/jiwo.lnk' $legacy
Invoke-ShortcutReconciliation @(Snapshot Startup $false $true) $new $legacy $true $read $write $remove
Assert-True ($links['Startup/jiwo.lnk'].Target -eq $new) 'existing Flutter startup must target 3.0'
$script:links=@{}
Invoke-ShortcutReconciliation @(Snapshot Startup $false $false) $new '' $false $read $write $remove
Assert-True ($links.Count -eq 0) 'fresh install must not enable startup'
# Unknown same-name links are never overwritten or deleted.
$script:links=@{}; & $write 'Desktop/jiwo.lnk' 'C:\Other\unrelated.exe'
$failed=$false
try { Invoke-ShortcutReconciliation @(Snapshot Desktop $false $false) $new '' $true $read $write $remove } catch { $failed=$true }
Assert-True $failed 'unknown shortcut must abort'
Assert-True ($links['Desktop/jiwo.lnk'].Target -eq 'C:\Other\unrelated.exe') 'unknown shortcut target must remain unchanged'
# Creation must be verified before removing the last old entry.
$script:links=@{}; & $write 'Desktop/arkme.lnk' $new
$failed=$false
try { Invoke-ShortcutReconciliation @(Snapshot Desktop $true $false) $new '' $true $read {param($p,$target)} $remove } catch { $failed=$true }
Assert-True $failed 'failed shortcut save must abort'
Assert-True ($links.ContainsKey('Desktop/arkme.lnk')) 'failed save must keep old entry available'
# Cross-scope source links carry desktop intent to the retained target scope.
foreach($direction in @('user-to-machine','machine-to-user')) {
 $script:links=@{}; & $write "$direction/legacy.lnk" $legacy
 $snap=@(Snapshot Desktop $false $false)+@([pscustomobject]@{Path="$direction/legacy.lnk";Role='Desktop';Canonical=$false;Existed=$true})
 Invoke-ShortcutReconciliation $snap $new $legacy $true $read $write $remove
 Assert-True ($links['Desktop/jiwo.lnk'].Target -eq $new) 'external source intent must create canonical entry in target scope'
 Assert-True (!$links.ContainsKey("$direction/legacy.lnk")) 'validated duplicate source shortcut must be retired'
}
Write-Output 'Shortcut reconciliation fixtures passed.' 
