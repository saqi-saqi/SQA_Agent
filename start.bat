@echo off
setlocal EnableDelayedExpansion
title TestFlow - Autonomous SQA Agent

cd /d "%~dp0"

cls
echo ================================================================
echo               TESTFLOW - AUTONOMOUS SQA AGENT                   
echo ================================================================
echo.
echo [1/3] Checking environment...

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Node.js is not found in your PATH!
    echo Please install Node.js 20+ from https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Check dependencies
if not exist "node_modules\" (
    echo [2/3] Installing dependencies (first-time setup)...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo Installing Playwright Chromium browser...
    call npx playwright install chromium
)

echo [2/3] Checking database...
if exist "data\testflow.sqlite" (
    echo       SQLite database detected.
) else (
    echo       Initializing SQLite database...
    if exist "scripts\migrate-json-to-sqlite.js" (
        call node scripts/migrate-json-to-sqlite.js >nul 2>&1
    )
)

echo [3/3] Starting TestFlow Dashboard Server...
echo.
echo ================================================================
echo   URL:      http://localhost:8080
echo   Status:   Running
echo   Database: SQLite (data/testflow.sqlite)
echo.
echo   * Keep this window open while testing.
echo   * Press Ctrl+C in this window to stop the server.
echo ================================================================
echo.

:: Automatically open browser after 2 seconds
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8080"

:: Launch the dashboard
call npm run start:dashboard

echo.
echo ================================================================
echo   TestFlow server has stopped.
echo ================================================================
pause
