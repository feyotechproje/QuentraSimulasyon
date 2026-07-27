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

echo [info] Building SuperMarketSim...
go build -o supermarketsim.exe ./cmd/server
if errorlevel 1 (
    echo [error] Build failed.
    exit /b 1
)

echo [info] Starting server on http://localhost:8080
echo [info] Press Ctrl+C to stop.
supermarketsim.exe

endlocal
