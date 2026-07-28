@echo off
rem IKWYD-Clone quick start (double-click). Uses node from PATH if available.
cd /d %~dp0
where node >nul 2>nul
if %errorlevel%==0 (
  node scripts\start.js %*
) else (
  if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe" (
    "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe" scripts\start.js %*
  ) else (
    echo Node.js not found in PATH. Please install Node.js 22+ or run: node scripts\start.js
    pause
  )
)
