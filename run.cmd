@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

if exist .env (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if not "%%a"=="" set "%%a=%%b"
  )
)

if "%API_PORT%"=="" set "API_PORT=3000"
if "%DASHBOARD_PORT%"=="" set "DASHBOARD_PORT=5173"

if exist "C:\Program Files\Git\bin\bash.exe" (
  set "npm_config_script_shell=C:\Program Files\Git\bin\bash.exe"
)

echo.
echo   ============================================
echo   ^|  brAIn                                   ^|
echo   ^|  API:       http://localhost:%API_PORT%        ^|
echo   ^|  Dashboard: http://localhost:%DASHBOARD_PORT%        ^|
echo   ============================================
echo.

call pnpm start
