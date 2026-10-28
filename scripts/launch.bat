@echo off
rem One-click launcher: starts Gemma + the TeX renderer (offline) and opens the app.
rem If everything is already running it just opens the app.
title HackDay Notes
cd /d "%~dp0.."

call :healthy
if %errorlevel%==0 goto open

if not exist "bin\llama.cpp" (
  echo First-time setup has not been run. With internet, run:
  echo   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
  pause
  exit /b 1
)

rem Servers run in their own minimised window; close it to shut everything down.
start "HackDay Notes - servers (close to stop)" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"

echo Loading Gemma and the TeX renderer, this takes about 20 seconds...
for /l %%i in (1,1,120) do (
  call :healthy
  if not errorlevel 1 goto open
  ping -n 2 127.0.0.1 >nul
)
echo Gemma did not start in time. Check the "HackDay Notes - servers" window for errors.
pause
exit /b 1

:open
rem Edge app mode gives a clean window with no browser chrome for the demo; fall back to the default browser.
where msedge >nul 2>nul && (start "" msedge --app=http://127.0.0.1:8080 & exit /b 0)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=http://127.0.0.1:8080
  exit /b 0
)
start "" http://127.0.0.1:8080
exit /b 0

:healthy
rem errorlevel 0 when both Gemma (:8080) and tikz-service (:3001) answer their health checks
powershell -NoProfile -Command "try { $g = Invoke-RestMethod -TimeoutSec 2 http://127.0.0.1:8080/health; $t = Invoke-RestMethod -TimeoutSec 2 http://127.0.0.1:3001/health; if ($g.status -eq 'ok' -and $t.ok) { exit 0 } } catch {}; exit 1"
exit /b %errorlevel%
