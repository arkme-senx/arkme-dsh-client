; The updater requests /S --updated --force-run. Keep that protocol compatible
; with older clients and show only the installation page of an in-app update.
!ifndef BUILD_UNINSTALLER
!include FileFunc.nsh
Var JiwoVisibleUpdate

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW JiwoUpdatePageShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE JiwoUpdatePageLeave
!macroend

!macro jiwoShowUpdateProgress
  ${If} ${isUpdated}
  ${AndIf} ${isForceRun}
  ${AndIf} ${Silent}
    ; The outer process of a machine-wide update must retain the builder's
    ; silent elevation path. Its elevated child will display the progress page.
    ${If} $hasPerMachineInstallation != "1"
    ${OrIf} ${UAC_IsAdmin}
      ${If} $hasPerMachineInstallation == "1"
        !insertmacro setInstallModePerAllUsers
      ${EndIf}
      StrCpy $JiwoVisibleUpdate "1"
      SetSilent normal
    ${EndIf}
  ${EndIf}
!macroend

!macro jiwoFinishVisibleUpdate
  ${If} $JiwoVisibleUpdate == "1"
    System::Call 'user32::RemovePropW(p $HWNDPARENT, w "cc.jiwo.arkme.update.active")'
  ${EndIf}
  ${If} ${isForceRun}
  ${AndIf} ${Silent}
  ${OrIf} $JiwoVisibleUpdate == "1"
    !insertmacro doStartApp
    ${If} $JiwoVisibleUpdate == "1"
      !insertmacro quitSuccess
    ${EndIf}
  ${EndIf}
!macroend

; A retry starts the same installer with its original updater arguments.
; Wait for the previous instance to release the builder's installer mutex.
!macro preInit
  ReadEnvStr $0 "JIWO_UPDATE_RETRY_PARENT"
  ${If} $0 != ""
    System::Call 'kernel32::SetEnvironmentVariableW(w "JIWO_UPDATE_RETRY_PARENT", p 0)'
    System::Call 'kernel32::OpenProcess(i 0x100000, i 0, i r0)p.r1'
    ${If} $1 != 0
      System::Call 'kernel32::WaitForSingleObject(p r1, i 10000)'
      System::Call 'kernel32::CloseHandle(p r1)'
    ${EndIf}
  ${EndIf}
!macroend

!macro jiwoUpdateFunctions
Function JiwoUpdatePageShow
  ${If} $JiwoVisibleUpdate == "1"
    SetDetailsView hide
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:即我正在更新"
    !insertmacro MUI_HEADER_TEXT "正在安装新版本" "安装完成后即我会自动打开，无需手动重启。"
    System::Call 'user32::SetPropW(p $HWNDPARENT, w "cc.jiwo.arkme.update.active", p 1)'
    BringToFront
  ${EndIf}
FunctionEnd

Function JiwoUpdatePageLeave
  ${If} $JiwoVisibleUpdate == "1"
    IfAbort 0 +2
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_COMMAND}, p 2, p 0)'
  ${EndIf}
FunctionEnd

Function JiwoUpdateFailureActions
  ${If} $JiwoVisibleUpdate != "1"
    Return
  ${EndIf}
  StrCpy $0 "$JiwoFailureText"
  ${If} $0 == ""
    StrCpy $0 "安装程序未完成文件更新。请重试，或下载完整安装包。"
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "JIWO_UPDATE_ERROR", w r0)'
  InitPluginsDir
  File /oname=$PLUGINSDIR\update-failed.ps1 "${JIWO_UPDATE_FAILURE_SCRIPT}"
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\update-failed.ps1"' $0
  ${If} $0 == 4
    System::Call 'kernel32::GetCurrentProcessId()i.r0'
    System::Call 'kernel32::SetEnvironmentVariableW(w "JIWO_UPDATE_RETRY_PARENT", w r0)'
    ${GetParameters} $0
    Exec '"$EXEPATH" $0'
    IfErrors 0 +2
    MessageBox MB_OK|MB_ICONSTOP "无法重新启动安装程序。请前往 https://jiwo.cc 下载完整安装包。"
  ${EndIf}
FunctionEnd
!macroend
!endif
