@echo off
setlocal enabledelayedexpansion
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

echo [1/3] Kontrola zdrojovych souboru...
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

echo [2/3] Instalace sestavovacich soucasti (nejnovejsi povolene verze dle package.json)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo CHYBA: Nepodarilo se stahnout nebo nainstalovat sestavovaci soucasti.
  echo Zkontrolujte internet a spustte tento soubor znovu.
  pause
  exit /b 1
)

echo [3/3] Vytvarim instalacni EXE...
call npm run dist
if errorlevel 1 (
  echo.
  echo CHYBA: Instalator se nepodarilo vytvorit.
  pause
  exit /b 1
)

echo.
echo ==============================================================
echo  HOTOVO
echo  Soubor: dist\Futures-Journal-PRO-Setup-%APPVER%.exe
echo ==============================================================
echo.
start "" "%~dp0dist"
pause
endlocal
