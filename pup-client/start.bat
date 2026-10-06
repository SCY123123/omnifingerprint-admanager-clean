@echo off
setlocal enableextensions
cd /d "%~dp0"
title OmniFingerprint PUP Server v2.4

echo =============================================
echo   OmniFingerprint PUP Server v2.4
echo   Portable - Node.js 22 + Chrome 142 bundled
echo =============================================
echo.

set PUPPETEER_PORT=9999
set LOG_LEVEL=INFO
set QUIET_LOGS=false
set AUTO_CLICK_VERIFY=true
set USE_BUNDLED_CHROME=true
set CHROME_PATH=%~dp0bundled-chrome\chrome.exe
set STORAGE_SERVER_URL=https://your-backend.example.com

if not exist "%~dp0pup-server.exe" (
    echo [ERROR] pup-server.exe not found. Please reinstall.
    pause
    exit /b 1
)

if not exist "%CHROME_PATH%" (
    echo [WARN] Bundled Chrome not found, will try system Chrome
    set USE_BUNDLED_CHROME=
    set CHROME_PATH=
)

if not exist "%~dp0logs" mkdir "%~dp0logs"
if not exist "%~dp0data" mkdir "%~dp0data"

echo [INFO] Starting PUP server on port %PUPPETEER_PORT% ...
echo [INFO] Chrome path: %CHROME_PATH%
echo [INFO] Working dir: %CD%
echo.

"%~dp0pup-server.exe"

echo.
echo [INFO] Server stopped
pause >nul
