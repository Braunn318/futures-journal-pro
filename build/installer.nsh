; Futures Journal PRO – vlastní NSIS makra
; ==========================================
; Appka je záměrně navržená tak, že křížkem/běžným zavíracím požadavkem se
; jen SCHOVÁ (kvůli běhu na pozadí a ikoně u hodin) – opravdu ukončí se jen
; přes "Ukončit aplikaci a záznam" v menu ikony u hodin. Instalátor ale při
; aktualizaci/reinstalaci zkouší zavřít běžící appku běžným (kooperativním)
; způsobem, který appka takhle schválně ignoruje – proto instalátor hlásil
; "nelze zavřít automaticky, zavřete ji ručně".
;
; Řešení: před instalací i před odinstalací vynutíme ukončení procesu podle
; jména .exe napřímo přes taskkill /F – appka tak nemá šanci to odmítnout,
; ať dělá cokoliv. Nezáleží na tom, jestli běží viditelně nebo jen na pozadí.

!macro customInit
  DetailPrint "Ukoncuji bezici Futures Journal PRO (pokud bezi)..."
  nsExec::ExecToLog 'taskkill /F /IM "Futures Journal PRO.exe" /T'
  Sleep 500
!macroend

!macro customUnInit
  DetailPrint "Ukoncuji bezici Futures Journal PRO (pokud bezi)..."
  nsExec::ExecToLog 'taskkill /F /IM "Futures Journal PRO.exe" /T'
  Sleep 500
!macroend
