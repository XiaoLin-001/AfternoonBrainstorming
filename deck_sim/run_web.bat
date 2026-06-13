@echo off
REM ============================================
REM  Advisor Web Server - http://localhost:8765
REM ============================================
cd /d "%~dp0"
title deck-sim-web
echo [web] serving http://localhost:8765/index.html
python -m http.server 8765
echo.
echo [web] process exited (code %errorlevel%).
echo [web] If it says "address already in use", another window is already serving 8765 - that is fine, close this one.
if not defined ADVISOR_NOPAUSE pause
