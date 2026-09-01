; Give Pyx documents the Pyx file icon (from archivo.svg → pltx.ico).
;
; Tauri 2's fileAssociations don't support a per-extension icon, so after the
; install (which registers the associations) we read whatever ProgID Tauri
; assigned to each extension and point its DefaultIcon at the pltx.ico bundled
; next to the executable. Reading the ProgID from the registry keeps this
; correct regardless of Tauri's internal naming.
;
; Both extensions get the SAME icon on purpose: a .tex opened with Pyx is a Pyx
; document as much as a .pltx is, and the point of the icon is to tell you at a
; glance, in the file explorer, which files this app owns.

!macro PyxSetIcon EXT
  ReadRegStr $0 SHCTX "Software\Classes\${EXT}" ""
  StrCmp $0 "" +2 0
    WriteRegStr SHCTX "Software\Classes\$0\DefaultIcon" "" "$INSTDIR\pltx.ico"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro PyxSetIcon ".pltx"
  !insertmacro PyxSetIcon ".tex"
  ; Ask Explorer to refresh its icon cache so the new icons show immediately.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
