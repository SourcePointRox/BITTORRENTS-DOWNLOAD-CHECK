@echo off
setlocal enabledelayedexpansion
title BITTORRENTS-DOWNLOAD-CHECK Launcher

echo ===============================================================
echo   BITTORRENTS-DOWNLOAD-CHECK  Full Service Launcher
echo   DHT + PEX + Tracker + BEP-52 v2/hybrid + MSE/PE + IPv6
echo ===============================================================
echo.

REM ---- Check Node.js ----
where node >nul 2>&1
if errorlevel 1 (
    echo [start] ERROR: Node.js not found. Please install Node.js 22.5+
    echo [start]   Download: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo [start] Node.js version: %NODE_VER%

REM ---- Parse arguments ----
set MODE=--sim
set ARG1=%~1
if /i "%ARG1%"=="live" set MODE=--live
if /i "%ARG1%"=="--live" set MODE=--live
if /i "%ARG1%"=="-l" set MODE=--live
if /i "%ARG1%"=="sim" set MODE=--sim
if /i "%ARG1%"=="--sim" set MODE=--sim
if /i "%ARG1%"=="-s" set MODE=--sim
if /i "%ARG1%"=="--help" goto :showhelp
if /i "%ARG1%"=="-h" goto :showhelp
if /i "%ARG1%"=="/?" goto :showhelp

echo [start] Collector mode: %MODE%
echo [start] Starting full service...
echo.

REM ---- Launch ----
node scripts/start.js %MODE% %2 %3 %4 %5 %6 %7 %8 %9

REM ---- Error handling ----
if errorlevel 1 (
    echo.
    echo [start] ERROR: Service failed to start. Check the error above.
    pause
)
goto :eof

:showhelp
echo.
echo Usage:
echo   start.bat              Simulation mode (default, no network needed)
echo   start.bat live         Real DHT + PEX + Tracker collection
echo   start.bat sim          Simulation mode
echo.
echo Pass-through start.js options:
echo   start.bat --live --port 9000 --monitor-port 9090
echo   start.bat --no-collector --no-monitor
echo.
echo Signal:
echo   Ctrl+C    Graceful shutdown
echo.
pause
goto :eof
