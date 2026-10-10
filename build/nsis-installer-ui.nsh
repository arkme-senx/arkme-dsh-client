!macro customWelcomePage
  ShowInstDetails show
  !define MUI_FINISHPAGE_NOAUTOCLOSE
!macroend

!ifdef JIWO_MIGRATION
  !include "${JIWO_MIGRATION_INCLUDE}"
!else
  !macro customInstallMode
    StrCpy $isForceCurrentInstall "1"
  !macroend
!endif
