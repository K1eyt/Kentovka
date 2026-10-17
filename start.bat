@echo off
chcp 65001 >nul
title Кентовка
cd /d "%~dp0"

rem Свой портативный Node.js в папке node — используем его в первую очередь
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден — скачаю портативную версию с nodejs.org, это один раз.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0get-node.ps1"
  if errorlevel 1 (
    echo.
    echo Не получилось скачать Node.js. Проверь интернет и запусти start.bat ещё раз.
    pause
    exit /b
  )
  set "PATH=%~dp0node;%PATH%"
)

if not exist node_modules (
  echo Ставлю зависимости, это один раз...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Не получилось поставить зависимости. Проверь интернет и запусти ещё раз.
    pause
    exit /b
  )
)

node server.js
pause
