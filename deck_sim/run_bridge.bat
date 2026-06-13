@echo off
REM ============================================
REM  Advisor Bridge (detector) - reads game logs
REM  Usage: run_bridge.bat [--dir "path"] [--once]
REM ============================================
cd /d "%~dp0"
title advisor-bridge
echo [bridge] starting with args: %*
node advisor_bridge.js %*
echo.
echo [bridge] process exited (code %errorlevel%).
if not defined ADVISOR_NOPAUSE pause
