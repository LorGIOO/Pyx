; Give .pltx documents the Pyx file icon (from archivo.svg → pltx.ico).
;
; Tauri 2's fileAssociations don't support a per-extension icon, so after the
; install (which registers the .pltx association) we read whatever ProgID Tauri
; assigned to .pltx and point its DefaultIcon at the pltx.ico bundled next to the
; executable. Reading the ProgID from the registry keeps this correct regardless
; of Tauri's internal naming.

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $0 SHCTX "Software\Classes\.pltx" ""
  StrCmp $0 "" pltx_icon_done 0
    WriteRegStr SHCTX "Software\Classes\$0\DefaultIcon" "" "$INSTDIR\pltx.ico"
    ; Ask Explorer to refresh its icon cache so the new icon shows immediately.
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  pltx_icon_done:
!macroend
