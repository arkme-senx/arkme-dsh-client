!macro customWelcomePage
  ShowInstDetails show
  !define MUI_FINISHPAGE_NOAUTOCLOSE
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
