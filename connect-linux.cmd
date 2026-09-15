@echo off
cd /d "%~dp0"
where node >nul 2>nul
if not errorlevel 1 (
  node "%~dp0deploy\connect-linux.mjs" %*
  exit /b
)
set "PULSE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%PULSE_NODE%" (
  "%PULSE_NODE%" "%~dp0deploy\connect-linux.mjs" %*
  exit /b
)
echo Install Node.js 24 or newer from https://nodejs.org/ and run this file again.
pause
