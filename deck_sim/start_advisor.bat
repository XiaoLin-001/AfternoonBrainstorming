@echo off
REM ============================================================
REM  Afternoon Brainstorming - Live Advisor (one-click launcher)
REM
REM  Usage:
REM    Double-click           -> watch the default game folder
REM    Drag a game folder on  -> watch that game's battle_records
REM ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node not found on PATH. Install Node.js first.
    pause
    exit /b 1
)
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] python not found on PATH. Install Python first.
    pause
    exit /b 1
)

set "REC="
if "%~1"=="" goto :launch
if exist "%~1\battle_records" (
    set "REC=%~1\battle_records"
) else (
    set "REC=%~1"
)

:launch
if defined REC (
    echo [INFO] watching: "%REC%"
    start "advisor-bridge" cmd /k call run_bridge.bat --dir "%REC%"
) else (
    echo [INFO] no folder given - bridge auto-searches default game paths.
    start "advisor-bridge" cmd /k call run_bridge.bat
)

start "deck-sim-web" cmd /k call run_web.bat
start "advisor-overlay" cmd /k call run_overlay.bat

echo [INFO] waiting 2s, then opening browser...
timeout /t 2 >nul
start "" http://localhost:8765/index.html
exit /b 0
