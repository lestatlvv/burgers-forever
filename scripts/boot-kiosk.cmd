@echo off
REM Launcher for Windows Task Scheduler / Startup.
REM Starts both services and opens the Demo Store in fullscreen kiosk mode.
cd /d "%~dp0.."
if "%KIOSK_BOOT_DELAY_SEC%"=="" set KIOSK_BOOT_DELAY_SEC=8

where node >nul 2>&1
if %ERRORLEVEL%==0 (
  node scripts\boot-kiosk.js
  exit /b %ERRORLEVEL%
)

if exist "%ProgramFiles%\nodejs\node.exe" (
  "%ProgramFiles%\nodejs\node.exe" scripts\boot-kiosk.js
  exit /b %ERRORLEVEL%
)

echo node.exe not found. Install Node.js and ensure it is on PATH.
exit /b 1
