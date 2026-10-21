; Migration bypasses builder uninstall/process functions; NSIS strips this dead code; its declared variables may also be unused.
; Keep warnings-as-errors for every other diagnostic.
!pragma warning disable 6010
!pragma warning disable 6001
; Included only by scripts/build-windows-artifacts.mjs in signed production builds.
!ifndef BUILD_UNINSTALLER
Var JiwoMigrationDestination
Var JiwoMigrationScope
Var JiwoMigrationKeepMachine
Var JiwoMigrationKeepUser
Var JiwoPreserveShortcuts
Var JiwoNativeUpdate
Var JiwoFailureText
Var JiwoFailureFile
Var JiwoFailureHandle
Var JiwoFailureLine
Var JiwoMigrationCommitted
!endif

!macro customInit
  StrCpy $JiwoMigrationCommitted "0"
  StrCpy $JiwoNativeUpdate "0"
  ${If} ${isUpdated}
    StrCpy $JiwoNativeUpdate "1"
  ${Else}
    !insertmacro windowsMigrationResolveInstallMode
  ${EndIf}
  InitPluginsDir
  File /oname=$PLUGINSDIR\windows-migration.ps1 "${JIWO_MIGRATION_SCRIPT}"
  File /oname=$PLUGINSDIR\windows-migration-manifest.json "${JIWO_MIGRATION_MANIFEST}"
!macroend

!macro windowsMigrationChooseScope USER_APP MACHINE_APP USER_FLUTTER MACHINE_FLUTTER RESULT
  ; Existing Arkme owns the destination; Flutter only determines scope for first migration.
  StrCpy ${RESULT} ""
  ${If} "${USER_APP}" != ""
    StrCpy ${RESULT} "current"
  ${ElseIf} "${MACHINE_APP}" != ""
    StrCpy ${RESULT} "all"
  ${ElseIf} "${MACHINE_FLUTTER}" != ""
    StrCpy ${RESULT} "all"
  ${ElseIf} "${USER_FLUTTER}" != ""
    StrCpy ${RESULT} "current"
  ${EndIf}
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
  StrCpy $JiwoMigrationKeepMachine "0"
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R1 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R2 HKCU "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\fcf12080-f7e3-1067-bed2-21ffecf3ae64_is1" InstallLocation
  ReadRegStr $R3 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\fcf12080-f7e3-1067-bed2-21ffecf3ae64_is1" InstallLocation
  SetRegView 32
  ReadRegStr $R4 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\fcf12080-f7e3-1067-bed2-21ffecf3ae64_is1" InstallLocation
  SetRegView 64
  ${If} $R3 == ""
    StrCpy $R3 $R4
  ${EndIf}
  !insertmacro windowsMigrationChooseScope $R0 $R1 $R2 $R3 $R7
  ${If} $R7 == "all"
    StrCpy $JiwoMigrationKeepMachine "1"
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
    !insertmacro setInstallModePerAllUsers
  ${EndIf}
  ${If} $R7 == "current"
    StrCpy $JiwoMigrationKeepUser "1"
    ; Shared Flutter is preserved; only an existing protected recovery needs elevation.
    StrCpy $R2 ""
    StrCpy $R3 ""
    ; A completed protected recovery record may outlive the Flutter registration.
    SetShellVarContext all
    StrCpy $R4 "$APPDATA\Jiwo Installer Transactions"
    SetShellVarContext current
    ; An empty discovery directory is not an unfinished transaction.
    FindFirst $R5 $R6 "$R4\S-1-*"
    ${If} $R6 != ""
      StrCpy $R2 "protected-recovery"
    ${EndIf}
    FindClose $R5
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
  ${If} $JiwoMigrationKeepMachine == "1"
    !insertmacro setInstallModePerAllUsers
    Abort
  ${EndIf}
  ${If} $JiwoMigrationKeepUser == "1"
    !insertmacro setInstallModePerUser
    Abort
  ${EndIf}
!macroend

; Print every line to installer details; the dialog uses the NSIS string limit.
; The full, untruncated error and transcript remain on disk.
!macro windowsMigrationShowFailure ACTION EXITCODE
  StrCpy $JiwoFailureText "安装失败（${ACTION}），退出码：${EXITCODE}$\r$\n原始错误文件：$JiwoFailureFile$\r$\n"
  DetailPrint $JiwoFailureText
  ClearErrors
  FileOpen $JiwoFailureHandle "$JiwoFailureFile" r
  ${IfNot} ${Errors}
    ${Do}
      ClearErrors
      FileReadUTF16LE $JiwoFailureHandle $JiwoFailureLine
      ${If} ${Errors}
        ${ExitDo}
      ${EndIf}
      DetailPrint $JiwoFailureLine
      StrCpy $JiwoFailureText "$JiwoFailureText$JiwoFailureLine"
    ${Loop}
    FileClose $JiwoFailureHandle
  ${Else}
    DetailPrint "安装脚本未返回错误文件（可能未能启动）。请检查系统拦截记录。"
    StrCpy $JiwoFailureText "$JiwoFailureText安装脚本未返回错误文件（可能未能启动）。请检查系统拦截记录。"
  ${EndIf}
  MessageBox MB_OK|MB_ICONSTOP "$JiwoFailureText" /SD IDOK
!macroend

!macro windowsMigrationRun ACTION
  StrCpy $JiwoMigrationScope current
  ${If} $installMode == "all"
    StrCpy $JiwoMigrationScope all
  ${EndIf}
  ; Use the system Windows PowerShell, never PATH lookup or an app-supplied executable.
  GetTempFileName $JiwoFailureFile
  Delete "$JiwoFailureFile"
  ClearErrors
  StrCpy $0 "-1"
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-migration.ps1" -Action ${ACTION} -Destination "$INSTDIR" -Scope "$JiwoMigrationScope" -Manifest "$PLUGINSDIR\windows-migration-manifest.json" -Stage "$PLUGINSDIR\jiwo-stage" -UninstallerName "${UNINSTALL_FILENAME}" -InstallerPath "$EXEPATH" -ShortcutPolicyFile "$PLUGINSDIR\jiwo-shortcuts.ini" -CompletionFile "$PLUGINSDIR\jiwo-committed.txt" -ErrorFile "$JiwoFailureFile"' $0
  ${If} ${Errors}
  ${OrIf} $0 != 0
    SetErrorLevel 1
    !insertmacro windowsMigrationShowFailure "${ACTION}" "$0"
    Abort
  ${EndIf}
  ReadINIStr $JiwoPreserveShortcuts "$PLUGINSDIR\jiwo-shortcuts.ini" "Shortcuts" "Preserve"
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
  ${If} $JiwoNativeUpdate != "1"
    StrCpy $INSTDIR "$PLUGINSDIR\jiwo-stage"
  ${EndIf}
  SetOutPath $INSTDIR
  !insertmacro installApplicationFiles
  !ifdef UNINSTALLER_ICON
    File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
  !endif
  ${If} $JiwoNativeUpdate != "1"
    StrCpy $INSTDIR $JiwoMigrationDestination
    SetOutPath $INSTDIR
    !insertmacro windowsMigrationRun Apply
  ${EndIf}
!macroend
!macro customInstall
  ; Finalize validates the complete installed payload before durable commit.
  ; Do not start another PowerShell just to repeat the same validation here.
!macroend
!macro windowsMigrationFinalize
  ${If} $JiwoPreserveShortcuts == "1"
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ShortcutName "$oldShortcutName"
  ${EndIf}
  WriteRegDWORD SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" JiwoVersionCode ${JIWO_VERSION_CODE}
  ${If} $JiwoNativeUpdate == "1"
    ; Stock NSIS has completed extraction and registration before this hook.
    StrCpy $JiwoMigrationCommitted "1"
  ${Else}
  !insertmacro windowsMigrationRun Finalize
  FileOpen $0 "$PLUGINSDIR\jiwo-committed.txt" r
  IfErrors jiwo_commit_failed
  FileRead $0 $1
  FileClose $0
  ${If} $1 == "${JIWO_VERSION_CODE}"
    StrCpy $JiwoMigrationCommitted "1"
    Goto jiwo_commit_ready
  ${EndIf}
  jiwo_commit_failed:
    DetailPrint "Finalize: missing or invalid installation completion marker: $PLUGINSDIR\jiwo-committed.txt"
    MessageBox MB_OK|MB_ICONSTOP "安装失败（Finalize）：安装完成标记缺失或与目标构建号不符。$\r$\n$PLUGINSDIR\jiwo-committed.txt" /SD IDOK
    SetErrorLevel 1
    Abort
  jiwo_commit_ready:
  ${EndIf}
  ; WScript reconciliation can replace the link property store; restore the stable AUMI.
  ${If} $JiwoPreserveShortcuts != "1"
  ${If} ${FileExists} "$newStartMenuLink"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${EndIf}
  ${If} ${FileExists} "$newDesktopLink"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${EndIf}
  ${EndIf}
!macroend

!macro customHeader
!ifndef BUILD_UNINSTALLER
Function .onInstFailed
  ${If} $JiwoMigrationDestination == ""
    ; Native update failure reporting must never enable manual rollback.
    StrCpy $JiwoMigrationScope current
    ${If} $installMode == "all"
      StrCpy $JiwoMigrationScope all
    ${EndIf}
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-migration.ps1" -Action Report -FailureContext NSIS -Destination "$INSTDIR" -Scope "$JiwoMigrationScope" -Manifest "$PLUGINSDIR\windows-migration-manifest.json"' $0
  ${EndIf}
  ${If} $JiwoMigrationDestination != ""
    GetTempFileName $JiwoFailureFile
    Delete "$JiwoFailureFile"
    ClearErrors
    StrCpy $0 "-1"
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-migration.ps1" -Action Rollback -FailureContext NSIS -Destination "$JiwoMigrationDestination" -Scope "$JiwoMigrationScope" -Manifest "$PLUGINSDIR\windows-migration-manifest.json" -ErrorFile "$JiwoFailureFile"' $0
    ${If} ${Errors}
    ${OrIf} $0 != 0
      !insertmacro windowsMigrationShowFailure "Rollback" "$0"
    ${Else}
      DetailPrint "Rollback completed."
    ${EndIf}
    SetErrorLevel 1
  ${EndIf}
FunctionEnd
!endif
!macroend
