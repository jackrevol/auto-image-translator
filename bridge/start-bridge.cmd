@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required.
  pause
  exit /b 1
)
if not exist "%~dp0..\node_modules\sharp\package.json" (
  echo Installing local image renderer...
  cd /d "%~dp0.."
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
  cd /d "%~dp0"
)
node server.js
if errorlevel 1 pause
