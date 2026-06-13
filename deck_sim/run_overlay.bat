@echo off
REM ============================================
REM  Floating hint overlay (on top of the game)
REM  Drag to move | double-click title to fold | X to close
REM ============================================
cd /d "%~dp0"
title advisor-overlay
python overlay_hint.py %*
echo.
echo [overlay] exited (code %errorlevel%).
if not defined ADVISOR_NOPAUSE pause
