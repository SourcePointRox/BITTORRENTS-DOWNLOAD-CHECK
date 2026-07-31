@echo off
chcp 65001 >nul 2>&1
title BITTORRENTS-DOWNLOAD-CHECK 全量服务启动器

echo ╔═══════════════════════════════════════════════════════════╗
echo ║   BITTORRENTS-DOWNLOAD-CHECK  全量服务启动                  ║
echo ║   DHT + PEX + Tracker + BEP-52 v2/hybrid + MSE/PE + IPv6   ║
echo ╚═══════════════════════════════════════════════════════════╝
echo.

REM ---- 检查 Node.js ----
where node >nul 2>&1
if errorlevel 1 (
    echo [启动] ✘ 未找到 Node.js，请先安装 Node.js 22.5+
    echo [启动]   下载地址：https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo [启动] Node.js 版本：%NODE_VER%

REM ---- 解析参数 ----
set MODE=--sim
if /i "%1"=="live" set MODE=--live
if /i "%1"=="--live" set MODE=--live
if /i "%1"=="-l" set MODE=--live
if /i "%1"=="sim" set MODE=--sim
if /i "%1"=="--sim" set MODE=--sim
if /i "%1"=="-s" set MODE=--sim
if /i "%1"=="--help" goto :showhelp
if /i "%1"=="-h" goto :showhelp
if /i "%1"=="/?" goto :showhelp

echo [启动] 采集模式：%MODE%
echo [启动] 正在启动全量服务...
echo.

REM ---- 启动 ----
node scripts/start.js %MODE% %2 %3 %4 %5 %6 %7 %8 %9

REM ---- 异常退出提示 ----
if errorlevel 1 (
    echo.
    echo [启动] ✘ 服务启动失败，请检查上方错误信息
    pause
)
goto :eof

:showhelp
echo.
echo 用法:
echo   start.bat              模拟采集模式（默认，无需网络）
echo   start.bat live         真实 DHT + PEX + Tracker 全网络采集
echo   start.bat sim          模拟采集模式
echo.
echo 也可直接传递 start.js 参数:
echo   start.bat --live --port 9000 --monitor-port 9090
echo   start.bat --no-collector --no-monitor
echo.
echo 信号:
echo   Ctrl+C    优雅关闭所有服务后退出
echo.
pause
goto :eof
