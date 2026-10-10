; Migration bypasses builder uninstall/process functions; NSIS strips this dead code; its declared variables may also be unused.
; Keep warnings-as-errors for every other diagnostic.
!pragma warning disable 6010
!pragma warning disable 6001
; Included only by scripts/build-windows-artifacts.mjs in signed production builds.
!ifndef BUILD_UNINSTALLER
Var JiwoMigrationDestination
Var JiwoMigrationScope
Var JiwoMigrationKeepUser
!endif

!macro customInit
  !insertmacro windowsMigrationResolveInstallMode
  InitPluginsDir
  File /oname=$PLUGINSDIR\windows-migration.ps1 "${JIWO_MIGRATION_SCRIPT}"
  File /oname=$PLUGINSDIR\windows-migration-manifest.json "${JIWO_MIGRATION_MANIFEST}"
!macroend

!macro windowsMigrationResolveInstallMode
  ; The outer process owns the original interactive identity. Do not reinterpret
  ; HKCU as another account when credentials were supplied in the UAC dialog.
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_GetGlobal $R0 $PROFILE
    ${If} $R0 != $PROFILE
      SetErrorLevel 1602
      Quit
    ${EndIf}
  ${EndIf}
  StrCpy $JiwoMigrationKeepUser "0"
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R1 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R0 != ""
  ${AndIf} $R1 == ""
    StrCpy $JiwoMigrationKeepUser "1"
    ; HKLM is only an elevation hint. PowerShell still verifies the full source
    ; identity, profile boundary, signatures and layout before any replacement.
    ReadRegStr $R2 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\fcf12080-f7e3-1067-bed2-21ffecf3ae64_is1" InstallLocation
    SetRegView 32
    ReadRegStr $R3 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\fcf12080-f7e3-1067-bed2-21ffecf3ae64_is1" InstallLocation
    SetRegView 64
    ; A completed protected recovery record may outlive the Flutter registration.
    SetShellVarContext all
    StrCpy $R4 "$APPDATA\Jiwo Installer Transactions"
    SetShellVarContext current
    IfFileExists "$R4\*.*" 0 +2
      StrCpy $R2 "protected-recovery"
    ${If} $R2 != ""
    ${OrIf} $R3 != ""
      ${IfNot} ${UAC_IsAdmin}
        !insertmacro UAC_RunElevated
        ${If} $0 != 0
          SetErrorLevel $0
          Quit
        ${EndIf}
        ${If} $1 == 1
          SetErrorLevel $2
          Quit
        ${EndIf}
        ${IfNot} ${UAC_IsAdmin}
          SetErrorLevel 1602
          Quit
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ; Elevation grants access to the legacy HKLM entry, not a different install scope.
    !insertmacro setInstallModePerUser
  ${EndIf}
!macroend

!macro windowsMigrationInstallMode
  ${If} $JiwoMigrationKeepUser == "1"
    !insertmacro setInstallModePerUser
    Abort
  ${EndIf}
!macroend

!macro windowsMigrationRun ACTION
  StrCpy $JiwoMigrationScope current
  ${If} $installMode == "all"
    StrCpy $JiwoMigrationScope all
  ${EndIf}
  ; Use the system Windows PowerShell, never PATH lookup or an app-supplied executable.
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-migration.ps1" -Action ${ACTION} -Destination "$INSTDIR" -Scope "$JiwoMigrationScope" -Manifest "$PLUGINSDIR\windows-migration-manifest.json" -Stage "$PLUGINSDIR\jiwo-stage" -UninstallerName "${UNINSTALL_FILENAME}" -InstallerPath "$EXEPATH"'
  Pop $0
  ${If} $0 != 0
    SetErrorLevel 1
    MessageBox MB_OK|MB_ICONSTOP "安装未完成。旧版程序与本地数据会保留，请查看安装详细信息，正常退出程序及内核后重试；迁移时请选择与旧版相同的安装范围。" /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro windowsMigrationGracefulCheck
  !insertmacro windowsMigrationRun Check
!macroend
!macro windowsMigrationPrepare
  StrCpy $JiwoMigrationDestination $INSTDIR
  !insertmacro windowsMigrationRun Prepare
  ; Recovery may have restored the previous ShortcutName/registry after initial UI setup.
  !insertmacro setLinkVars
!macroend
!macro windowsMigrationStage
  ; Extract into the installer-owned staging directory before changing any existing file.
  StrCpy $INSTDIR "$PLUGINSDIR\jiwo-stage"
  SetOutPath $INSTDIR
  !insertmacro installApplicationFiles
  !ifdef UNINSTALLER_ICON
    File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
  !endif
  StrCpy $INSTDIR $JiwoMigrationDestination
  SetOutPath $INSTDIR
  !insertmacro windowsMigrationRun Apply
!macroend
!macro customInstall
  !insertmacro windowsMigrationRun Commit
!macroend
!macro windowsMigrationFinalize
  WriteRegDWORD SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" JiwoVersionCode ${JIWO_VERSION_CODE}
  !insertmacro windowsMigrationRun Finalize
  ; WScript reconciliation can replace the link property store; restore the stable AUMI.
  ${If} ${FileExists} "$newStartMenuLink"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${EndIf}
  ${If} ${FileExists} "$newDesktopLink"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${EndIf}
!macroend

!macro customHeader
!ifndef BUILD_UNINSTALLER
Function .onInstFailed
  ${If} $JiwoMigrationDestination != ""
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-migration.ps1" -Action Rollback -Destination "$JiwoMigrationDestination" -Scope "$JiwoMigrationScope" -Manifest "$PLUGINSDIR\windows-migration-manifest.json"'
    Pop $0
  ${EndIf}
FunctionEnd
!endif
!macroend
