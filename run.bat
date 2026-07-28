@echo off
REM ============================================================
REM  Supermarket Checkout Simulation - run helper
REM  Loads settings from .env (create one from .env.example).
REM ============================================================
setlocal

cd /d "%~dp0"

if not exist ".env" (
    echo [warn] .env not found. Copying .env.example -^> .env
    copy /Y ".env.example" ".env" >nul
    echo [warn] Edit .env and set DB_PASSWORD before running in production.
)

REM Stop a previous instance before rebuilding. Otherwise the old process keeps
REM serving the embedded web files from memory and the new build cannot bind to
REM the same HTTP port.
taskkill /F /IM supermarketsim.exe >nul 2>&1
if not errorlevel 1 echo [info] Stopped previous SuperMarketSim instance.

echo [info] Building SuperMarketSim...
go build -o supermarketsim.exe ./cmd/server
if errorlevel 1 (
    echo [error] Build failed.
    exit /b 1
)

set "HTTP_ADDR=:8080"
for /f "usebackq tokens=1,* delims==" %%A in (".env") do if /I "%%A"=="HTTP_ADDR" set "HTTP_ADDR=%%B"

echo [info] Starting server on http://localhost%HTTP_ADDR%
echo [info] Press Ctrl+C to stop.
supermarketsim.exe

endlocal
