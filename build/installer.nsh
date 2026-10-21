; build/installer.nsh — the installer closes a running KoneqtiSEO Launcher itself (owner 21 Oct 2026: "launcher is not
; closed, close it manually" — closing the window only hides it in the tray). Only the launcher is closed; the Chrome
; windows it opened stay open.
!macro customCheckAppRunning
  nsExec::Exec 'taskkill /F /IM "KoneqtiSEO Launcher.exe"'
  Pop $0
  Sleep 1500
!macroend
