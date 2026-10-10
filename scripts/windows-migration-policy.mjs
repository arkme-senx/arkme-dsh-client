import path from 'node:path';
export function validateReleaseIdentity({ appId, unsigned }) {
  if (appId !== 'cc.jiwo.arkme') throw new Error('Migration is production only');
  if (unsigned) throw new Error('Migration requires signed release artifacts');
}
export function planLegacyMigration(installs, destination, scope, context = {}) {
  if (installs.length > 1) throw new Error('Refusing multiple legacy installations');
  if (!installs.length) return null;
  const item = installs[0];
  const normalize = p => path.win32.resolve(p).toLowerCase().replace(/\\+$/, '');
  const oldRoot = normalize(item.root), newRoot = normalize(destination);
  if (oldRoot === newRoot || oldRoot.startsWith(newRoot+'\\') || newRoot.startsWith(oldRoot+'\\')) throw new Error('Install directories overlap');
  if (item.scope !== scope) {
    const profile = context.profile ? normalize(context.profile) + '\\' : '';
    const oldUser = profile && oldRoot.startsWith(profile), newUser = profile && newRoot.startsWith(profile);
    const sharedSource = (context.programRoots || []).some(p => oldRoot.startsWith(normalize(p)+'\\'));
    const permitted = context.elevated === true && context.existingArkme === true && profile && (
      (item.scope === 'all' && scope === 'current' && newUser && (oldUser || sharedSource) && context.otherProfiles === 0) ||
      (item.scope === 'current' && scope === 'all' && oldUser && !newUser)
    );
    if (!permitted) throw new Error('Installation scope mismatch');
  }
  if (!item.signed) throw new Error('Untrusted legacy signature');
  if (!item.knownLayout) throw new Error('Unknown legacy layout');
  // Disable only the verified launcher and dangerous old uninstall entry point. Assets, kernel, unknown files and local data stay in place.
  return { ...item, retire: ['jotmo.exe', 'unins000.exe'] };
}
export function patchInstallSection(source) {
  const uninstall = `!insertmacro uninstallOldVersion SHELL_CONTEXT
!insertmacro handleUninstallResult SHELL_CONTEXT

\${if} $installMode == "all"
  !insertmacro uninstallOldVersion HKEY_CURRENT_USER
  !insertmacro handleUninstallResult HKEY_CURRENT_USER
\${endIf}`;
  const shortcuts = '!insertmacro addStartMenuLink $keepShortcuts\n!insertmacro addDesktopLink $keepShortcuts';
  const commit = '!ifmacrodef customInstall\n  !insertmacro customInstall\n!endif';
  const icon = '!ifdef UNINSTALLER_ICON\n  File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"\n!endif';
  const anchors = [uninstall, shortcuts, commit, icon, '!insertmacro installApplicationFiles'];
  if (anchors.some(anchor => source.split(anchor).length !== 2) || source.split('!insertmacro CHECK_APP_RUNNING').length !== 3) throw new Error('Unsupported electron-builder NSIS template');
  return source.replace(icon, '').replace(uninstall, '!insertmacro windowsMigrationPrepare')
    .replace('!insertmacro installApplicationFiles', '!insertmacro windowsMigrationStage')
    .replace(shortcuts, '').replace(commit, commit+'\n'+shortcuts+'\n!insertmacro windowsMigrationFinalize')
    .replaceAll('!insertmacro CHECK_APP_RUNNING', '!insertmacro windowsMigrationGracefulCheck');
}

export function patchShortcutMacros(source) {
  for (const [kind, indent] of [['StartMenu', '      '], ['Desktop', '        ']]) {
    const rename = `Rename $old${kind}Link $new${kind}Link`;
    const uninstall = `WinShell::UninstShortcut "$old${kind}Link"`;
    const aumi = `WinShell::SetLnkAUMI "$new${kind}Link" "\${APP_ID}"`;
    const anchor = `${indent}${rename}\n${indent}${uninstall}\n${indent}${aumi}`;
    if (source.split(anchor).length !== 2) throw new Error('Unsupported electron-builder shortcut template');
    // Coexisting Flutter may already own the canonical name. A failed rename
    // must leave both links byte-identical for recovery; Finalize reconciles them.
    source = source.replace(anchor, `${indent}ClearErrors\n${indent}${rename}\n${indent}\${ifNot} \${Errors}\n${indent}  ${uninstall}\n${indent}  ${aumi}\n${indent}\${endIf}\n${indent}ClearErrors`);
  }
  return source;
}

export function patchInstallModePage(source) {
  const anchor='\tFunction "${UNINSTALLER_FUNCPREFIX}${PRE}"\n';
  if (source.split(anchor).length !== 2) throw new Error('Unsupported electron-builder install mode template');
  return source.replace(anchor, anchor + `    !ifndef BUILD_UNINSTALLER
      !ifmacrodef windowsMigrationInstallMode
        !insertmacro windowsMigrationInstallMode
      !endif
    !endif
`);
}
