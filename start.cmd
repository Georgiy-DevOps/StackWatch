@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 or newer from https://nodejs.org/
  pause
  exit /b 1
)
echo Open http://127.0.0.1:4310 in your browser after startup.
node --env-file-if-exists=.env server.mjs
pause
