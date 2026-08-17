@echo off
chcp 65001 >nul
cd /d "%~dp0desktop"
where py >nul 2>nul
if errorlevel 1 (
  echo Python 3.10 or later is required.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  py -3.10 -m venv .venv
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
if not exist ".venv\.ready" (
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 (
    pause
    exit /b 1
  )
  type nul > ".venv\.ready"
)
".venv\Scripts\python.exe" main.py
