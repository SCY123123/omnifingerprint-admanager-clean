@echo off
chcp 65001 >nul
title OmniFingerprint-PUP-Server
cd /d "%~dp0"

:: ========== Config ==========
set PUPPETEER_PORT=9999
set LOG_LEVEL=INFO
set QUIET_LOGS=false
set AUTO_CLICK_VERIFY=true
set PUPPETEER_API_SECRET=your_local_secret_here
set STORAGE_SERVER_URL=https://your-backend.example.com
:: ============================

echo =============================================
echo   OmniFingerprint PUP Server
echo   Port: %PUPPETEER_PORT%
echo =============================================
echo.

if not exist "%~dp0pup-server.exe" (
    echo [ERROR] pup-server.exe not found!
    pause
    exit /b 1
)

if not exist "%~dp0data\" mkdir "%~dp0data"
if not exist "%~dp0logs\" mkdir "%~dp0logs"

:: ========== Auto-detect Chrome / Edge ==========
if not defined CHROME_PATH (
    set "CHROME_LIST=C:\Program Files\Google\Chrome\Application\chrome.exe"
    set "CHROME_LIST=%CHROME_LIST%;C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    set "CHROME_LIST=%CHROME_LIST%;C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    set "CHROME_LIST=%CHROME_LIST%;C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    set "CHROME_LIST=%CHROME_LIST%;%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
    set "CHROME_LIST=%CHROME_LIST%;%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
    set "CHROME_LIST=%CHROME_LIST%;%LOCALAPPDATA%\Chromium\Application\chrome.exe"

    for %%c in (%CHROME_LIST%) do (
        if exist "%%c" (
            echo [INFO] Browser found: %%c
            set "CHROME_PATH=%%c"
            goto :CHROME_FOUND
        )
    )
    echo [WARN] Chrome/Edge not detected, make sure a browser is installed.
) else (
    echo [INFO] Using custom CHROME_PATH: %CHROME_PATH%
)
:CHROME_FOUND

echo [INFO] Starting PUP Server ...
echo.

"%~dp0pup-server.exe"

echo.
echo [INFO] Server stopped.
pause >nul
