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
;
; NIKDY ne taskkill /T (4.8.102-test.6): automatická aktualizace spouští
; instalátor jako POTOMKA běžící appky. /T zabije celý strom procesů appky –
; i právě běžící instalátor. Appka se pak zavřela a nic se nenainstalovalo;
; prošlo to jen tehdy, když appka stihla skončit dřív (proto „na druhý
; pokus“). Pomocné procesy Electronu mají stejné jméno .exe, takže je
; taskkill /IM ukončí i bez /T; instalátor se jmenuje jinak a přežije.
; Pak se čeká (max. ~5 s), až procesy appky opravdu zmizí – jinak by
; instalace narazila na zamčené soubory.

!include LogicLib.nsh

!macro fjKillRunningApp
  Push $R8
  Push $R9
  DetailPrint "Ukoncuji bezici Futures Journal PRO (pokud bezi)..."
  StrCpy $R9 0
  ${Do}
    nsExec::Exec 'taskkill /F /IM "Futures Journal PRO.exe"'
    Pop $R8
    Sleep 500
    ; find vrátí 0, když proces appky ještě běží
    nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq Futures Journal PRO.exe" /NH | find /I "Futures Journal PRO.exe"'
    Pop $R8
    ${If} $R8 != 0
      ${Break}
    ${EndIf}
    IntOp $R9 $R9 + 1
  ${LoopUntil} $R9 >= 10
  Pop $R9
  Pop $R8
!macroend

!macro customInit
  !insertmacro fjKillRunningApp
!macroend

!macro customUnInit
  !insertmacro fjKillRunningApp
!macroend
