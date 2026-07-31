@echo off
setlocal enabledelayedexpansion
title BITTORRENTS-DOWNLOAD-CHECK Launcher

REM Switch to this .bat file's directory (fixes path issues when double-clicked from explorer)
cd /d "%~dp0"

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
echo.

REM ---- Parse arguments / interactive menu ----
set MODE=
set ARG1=%~1
set PASSTHRU=

REM If first arg is a known mode keyword, use it directly
if /i "%ARG1%"=="live" ( set MODE=--live& set PASSTHRU=%2%3%4%5%6%7%8%9& goto :launch )
if /i "%ARG1%"=="--live" ( set MODE=--live& goto :collectargs )
if /i "%ARG1%"=="sim" ( set MODE=--sim& set PASSTHRU=%2%3%4%5%6%7%8%9& goto :launch )
if /i "%ARG1%"=="--sim" ( set MODE=--sim& goto :collectargs )
if /i "%ARG1%"=="off" ( set MODE=--no-collector& set PASSTHRU=%2%3%4%5%6%7%8%9& goto :launch )
if /i "%ARG1%"=="--no-collector" ( set MODE=--no-collector& goto :collectargs )
if /i "%ARG1%"=="--help" goto :showhelp
if /i "%ARG1%"=="-h" goto :showhelp
if /i "%ARG1%"=="/?" goto :showhelp

REM If first arg starts with -- (pass-through option like --port), launch sim with all args
if defined ARG1 (
    set FIRSTCHAR=%ARG1:~0,2%
    if "!FIRSTCHAR!"=="--" ( set MODE=--sim& goto :collectargs )
)

REM No valid mode argument -> show interactive menu
:menu
echo ---------------------------------------------------------------
echo   Select collector mode:
echo.
echo   [1] OFF   - Site only, no collector
echo   [2] SIM   - Simulation mode (default, no network needed)
echo   [3] LIVE  - Real DHT + PEX + Tracker collection
echo   [4] HELP  - Show full help
echo   [0] EXIT
echo.
set /p CHOICE="Enter choice [1-4, 0]: "

if "%CHOICE%"=="1" set MODE=--no-collector& goto :launch
if "%CHOICE%"=="2" set MODE=--sim& goto :launch
if "%CHOICE%"=="3" set MODE=--live& goto :launch
if "%CHOICE%"=="4" goto :showhelp
if "%CHOICE%"=="0" goto :eof
echo Invalid choice. Please enter 1, 2, 3, 4, or 0.
echo.
goto :menu

REM Collect remaining pass-through args (after --mode keyword)
:collectargs
set PASSTHRU=
set /a ARGIDX=0
for %%a in (%*) do (
    set /a ARGIDX+=1
    if !ARGIDX! geq 2 set PASSTHRU=!PASSTHRU! %%a
)
goto :launch

:launch
echo.
echo [start] Collector mode: %MODE%
if defined PASSTHRU echo [start] Extra args: %PASSTHRU%
echo [start] Starting full service...
echo.

node scripts/start.js %MODE% %PASSTHRU%

if errorlevel 1 (
    echo.
    echo [start] ERROR: Service failed to start. Check the error above.
    pause
)
goto :eof

:showhelp
echo.
echo Usage:
echo   start.bat              Show interactive mode menu
echo   start.bat off          Site only, no collector
echo   start.bat sim          Simulation mode (default)
echo   start.bat live         Real DHT + PEX + Tracker collection
echo.
echo Pass-through start.js options (after mode):
echo   start.bat --sim --port 9000 --monitor-port 9090
echo   start.bat --live --dht-port 6881 --dht-instances 3
echo   start.bat --no-collector --no-monitor
echo.
echo Signal:
echo   Ctrl+C    Graceful shutdown
echo.
pause
goto :eof
