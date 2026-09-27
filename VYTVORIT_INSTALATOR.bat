@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem Verze se cte primo z package.json, aby tenhle text nikdy nezustal
rem "zaseknuty" na starem cisle, i kdyz se aplikace aktualizuje.
set "APPVER=neznama"
for /f "usebackq tokens=2 delims=:," %%a in (`findstr /r /c:"\"version\"" package.json`) do (
  set "APPVER=%%~a"
)
set "APPVER=%APPVER: =%"
set "APPVER=%APPVER:"=%"

rem Sestavuje se ve stale pracovni slozce na internim disku, ne ve slozce,
rem odkud se tenhle soubor spusti. Kazda nove rozbalena verze by jinak
rem instalovala ~7500 souboru sestavovacich soucasti znovu - na externim
rem disku a s antivirem, ktery kontroluje kazdy z nich, to trvalo i desitky
rem minut. Ve stale slozce se instaluji jen poprve (a kdyz se zmeni).
rem Hotovy instalator se kopiruje zpet do dist\ vedle tohoto souboru.
set "WS=%LOCALAPPDATA%\FuturesJournalPRO-build"
set "LOCK=%WS%\.build-lock"
set "LOCKED="
set "PUSHED="

title Futures Journal PRO %APPVER% - vytvoreni instalatoru

echo ==============================================================
echo  FUTURES JOURNAL PRO %APPVER% - VYTVORENI CISTEHO INSTALATORU
echo ==============================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo CHYBA: Node.js neni nainstalovan.
  echo Nainstalujte Node.js LTS a pote tento soubor spustte znovu.
  echo.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo CHYBA: npm nebyl nalezen.
  echo Preinstalujte Node.js LTS.
  pause
  exit /b 1
)
for /f %%t in ('node -e "process.stdout.write(String(Date.now()))"') do set "T0=%%t"

echo [1/4] Kontrola zdrojovych souboru... (%time:~0,8%)
if not exist "app\index.html" (
  echo CHYBA: Chybi app\index.html. Instalator nelze vytvorit.
  pause
  exit /b 1
)
if not exist "main.js" (
  echo CHYBA: Chybi main.js.
  pause
  exit /b 1
)

if not exist "%WS%" mkdir "%WS%"
mkdir "%LOCK%" 2>nul
if errorlevel 1 goto :locked
:lockacquired
set "LOCKED=1"

echo [2/4] Kopiruji zdrojove soubory do pracovni slozky... (%time:~0,8%)
echo       %WS%
rem /MIR smaze i soubory, ktere nova verze uz nema. Slozky z /XD se
rem v cili nemazou - node_modules a dist tak zustavaji mezi sestavenimi.
robocopy "%~dp0." "%WS%" /MIR /XD node_modules dist .git tests .build-lock /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  set "FAILMSG=Nepodarilo se zkopirovat zdrojove soubory do %WS%."
  set "FAILHINT="
  goto :fail
)

pushd "%WS%"
set "PUSHED=1"

echo [3/4] Instalace sestavovacich soucasti... (%time:~0,8%)
echo       Prvni sestaveni muze trvat nekolik minut - antivirus kontroluje
echo       kazdy instalovany soubor. Dalsi sestaveni uz jen chvili.
call npm install --no-audit --no-fund --prefer-offline
if errorlevel 1 (
  set "FAILMSG=Nepodarilo se stahnout nebo nainstalovat sestavovaci soucasti."
  set "FAILHINT=Zkontrolujte internet a spustte tento soubor znovu."
  goto :fail
)

echo [4/4] Vytvarim instalacni EXE... (%time:~0,8%)
rem Stare instalatory z predchozich verzi pryc - jinak by se pracovni slozka
rem plnila a hrozilo by zkopirovani stareho souboru misto noveho.
del /q "dist\*.exe" "dist\*.blockmap" "dist\latest.yml" 2>nul
call npm run dist
if errorlevel 1 (
  set "FAILMSG=Instalator se nepodarilo vytvorit."
  set "FAILHINT="
  goto :fail
)
if not exist "dist\Futures-Journal-PRO-Setup-%APPVER%.exe" (
  set "FAILMSG=Sestaveni skoncilo, ale soubor Futures-Journal-PRO-Setup-%APPVER%.exe nevznikl."
  set "FAILHINT="
  goto :fail
)

if not exist "%~dp0dist" mkdir "%~dp0dist"
copy /y "dist\Futures-Journal-PRO-Setup-%APPVER%.exe" "%~dp0dist\" >nul
if errorlevel 1 (
  set "FAILMSG=Instalator vznikl, ale nepodarilo se ho zkopirovat do %~dp0dist."
  set "FAILHINT=Najdete ho v %WS%\dist."
  goto :fail
)
if exist "dist\Futures-Journal-PRO-Setup-%APPVER%.exe.blockmap" copy /y "dist\Futures-Journal-PRO-Setup-%APPVER%.exe.blockmap" "%~dp0dist\" >nul
if exist "dist\latest.yml" copy /y "dist\latest.yml" "%~dp0dist\" >nul

call :cleanup
for /f %%s in ('node -e "process.stdout.write(String(Math.round((Date.now()-%T0%)/1000)))"') do set "SECS=%%s"

echo.
echo ==============================================================
echo  HOTOVO za %SECS% s
echo  Soubor: dist\Futures-Journal-PRO-Setup-%APPVER%.exe
echo ==============================================================
echo.
start "" "%~dp0dist"
pause
endlocal
exit /b 0

rem Jine sestaveni pouziva stejnou pracovni slozku - dve naraz by si
rem prepisovaly soubory. Zamek muze zustat i po zavrenem okne uprostred
rem sestaveni, proto jde pokracovat rucne.
:locked
echo.
echo Pracovni slozku prave pouziva jine sestaveni, nebo bylo minule
echo sestaveni preruseno (zavrene okno).
choice /c AN /m "Pokracovat presto? A = ano (zadne jine sestaveni nebezi), N = ne"
if errorlevel 2 (
  endlocal
  exit /b 1
)
goto :lockacquired

:fail
echo.
echo CHYBA: %FAILMSG%
if defined FAILHINT echo %FAILHINT%
call :cleanup
pause
endlocal
exit /b 1

:cleanup
if defined PUSHED popd
set "PUSHED="
if defined LOCKED rd "%LOCK%" 2>nul
set "LOCKED="
exit /b 0
