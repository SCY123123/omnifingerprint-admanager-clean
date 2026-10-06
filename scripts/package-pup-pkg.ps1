#Requires -Version 5.1

<#
.SYNOPSIS
    OmniFingerprint PUP Server EXE Installer Builder
.DESCRIPTION
    Builds a proper Windows .exe installer using @yao-pkg/pkg + Inno Setup.
    - Staging = full server business code (ALL local modules required by the entry)
      + the real server\node_modules + server\package.json (version bumped).
    - pkg compiles with node22-win-x64 (runtime is embedded, target PC needs no Node).
    - No dev data included (no db / .env / browser-profiles).
    NOTE: keep this file pure ASCII (PowerShell 5.1 reads BOM-less ps1 as ANSI).
#>

$ErrorActionPreference = 'Stop'
$ProjectRoot = "d:\omnifingerprint-admanager-clean"
$ServerDir = Join-Path $ProjectRoot "server"

# ---- Configuration ----
$StagingName = ".pkg-staging"
$StagingPath = Join-Path $ProjectRoot $StagingName
$OutputExe = "pup-server.exe"
# node18: official pkg 5.8.1 only ships base binaries up to node18.
# Source mode (--no-bytecode --public --public-packages "*") MUST use official pkg 5.8.1:
# the @yao-pkg fork stores every required .js as V8 bytecode unconditionally, so
# --no-bytecode fails with "--no-bytecode and no source breaks final executable".
$PKG_TARGET = "node18-win-x64"
$PkgSpec = "pkg@5.8.1"
$AppVersion = "2.6.1"
$InstallerOutputDir = Join-Path $ProjectRoot "installer-output"
$InnoScript = Join-Path $ProjectRoot "scripts\pup-installer.iss"

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  OmniFingerprint PUP Installer Builder v$AppVersion" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================
# Step 1: Check prerequisites
# ============================================================
Write-Host "[1/8] Checking build environment..." -ForegroundColor Cyan

$isccPath = $null
$isccPaths = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 6\ISCC.exe"
)
foreach ($p in $isccPaths) {
    if (Test-Path $p) { $isccPath = $p; break }
}
if ($isccPath) {
    Write-Host "       + Inno Setup found: $isccPath" -ForegroundColor Green
} else {
    Write-Host "       ! ISCC.exe not found, installer step will be skipped" -ForegroundColor Yellow
}

if (!(Test-Path (Join-Path $ServerDir "node_modules"))) {
    Write-Host "       [ERROR] server\node_modules missing. Run npm install in server\ first." -ForegroundColor Red
    exit 1
}
Write-Host "       + server\node_modules available" -ForegroundColor Green

# ============================================================
# Step 2: Clean & Create Staging
# ============================================================
Write-Host "[2/8] Creating staging directory..." -ForegroundColor Cyan

if (Test-Path $StagingPath) {
    Remove-Item $StagingPath -Recurse -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

$null = New-Item -ItemType Directory -Path (Join-Path $StagingPath "payment") -Force
$null = New-Item -ItemType Directory -Path (Join-Path $StagingPath "integrations") -Force
$null = New-Item -ItemType Directory -Path (Join-Path $StagingPath "data") -Force
$null = New-Item -ItemType Directory -Path (Join-Path $StagingPath "logs") -Force

Write-Host "       Staging ready." -ForegroundColor Green

# ============================================================
# Step 3: Copy ALL server business code + package.json
#   The entry (puppeteer-api-server.js) requires 20+ local modules;
#   missing any of them breaks the packaged exe (Cannot find module './proxy-tunnel').
# ============================================================
Write-Host "[3/8] Copying server business code (no dev data)..." -ForegroundColor Cyan

# top-level business .js files; exclude temp/debug scripts
$excludedJs = @(
    'playwright-api-server.js',
    'storage-api-server.js'
)
Get-ChildItem $ServerDir -File -Filter "*.js" | Where-Object {
    $_.Name -notlike "_*" -and $_.Name -notlike "temp-*" -and $_.Name -notin $excludedJs
} | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination (Join-Path $StagingPath $_.Name) -Force
}
Write-Host "       Copied $((Get-ChildItem $StagingPath -File -Filter '*.js').Count) top-level .js files"

# sub-directories required by the entry
Copy-Item (Join-Path $ServerDir "payment\*.js") (Join-Path $StagingPath "payment\") -Force
Copy-Item (Join-Path $ServerDir "integrations\*.js") (Join-Path $StagingPath "integrations\") -Force
Write-Host "       Copied payment\ + integrations\"

# package.json (real dependency manifest + pkg assets config), bump version
# NOTE: must read/write as UTF-8 (no BOM) - the file contains Chinese text and
#       ANSI round-trip corrupts it into invalid JSON ("Bad control character")
$pkgJsonRaw = [IO.File]::ReadAllText((Join-Path $ServerDir "package.json"), [Text.Encoding]::UTF8)
$pkgJsonRaw = $pkgJsonRaw -replace '"version"\s*:\s*"[^"]*"', ('"version": "' + $AppVersion + '"')
[IO.File]::WriteAllText((Join-Path $StagingPath "package.json"), $pkgJsonRaw, (New-Object Text.UTF8Encoding($false)))
Write-Host "       package.json copied (version -> $AppVersion)"

Write-Host "       Excluded: *.db / *.sqlite / .env* / browser-profiles / data" -ForegroundColor Green

# ============================================================
# Step 4: Copy the real server node_modules (includes @yao-pkg/pkg)
# ============================================================
Write-Host "[4/8] Copying server\node_modules (this may take a while)..." -ForegroundColor Cyan

$dstMod = Join-Path $StagingPath "node_modules"
$null = New-Item -ItemType Directory -Path $dstMod -Force
Get-ChildItem (Join-Path $ServerDir "node_modules") -Directory | Where-Object {
    $_.Name -ne 'omnifingerprint-admanager' -and $_.Name -notin @('.bin')
} | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination (Join-Path $dstMod $_.Name) -Recurse -Force -ErrorAction SilentlyContinue
}
$binSrc = Join-Path $ServerDir "node_modules\.bin"
if (Test-Path $binSrc) {
    Copy-Item -Path $binSrc -Destination (Join-Path $dstMod ".bin") -Recurse -Force
}
Write-Host "       node_modules copied." -ForegroundColor Green

# ============================================================
# Step 5: Verify sqlite3 native module
# ============================================================
Write-Host "[5/8] Verifying sqlite3 native module..." -ForegroundColor Cyan

$sqliteNativePath = Join-Path $dstMod "sqlite3\build\Release\node_sqlite3.node"
if (Test-Path $sqliteNativePath) {
    Write-Host "       + sqlite3 native module OK" -ForegroundColor Green
} else {
    $found = Get-ChildItem -Path (Join-Path $dstMod "sqlite3") -Recurse -Filter "node_sqlite3.node" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
        Write-Host "       + sqlite3 native module found: $($found.FullName)" -ForegroundColor Green
    } else {
        Write-Host "       [WARN] sqlite3 native module NOT found! SQLite may not work in pkg build." -ForegroundColor Red
    }
}

# ============================================================
# Step 6: Compile with pkg to pup-server.exe
# ============================================================
Write-Host "[6/8] Compiling with pkg ($PKG_TARGET)..." -ForegroundColor Cyan

$pkgOutputPath = Join-Path $ProjectRoot $OutputExe
if (Test-Path $pkgOutputPath) {
    Remove-Item $pkgOutputPath -Force -ErrorAction SilentlyContinue
}

Push-Location $StagingPath
try {
    Write-Host "       Output: $pkgOutputPath" -ForegroundColor Yellow
    Write-Host "       Compiling, please wait (1-3 minutes)..." -ForegroundColor Yellow

    # route through cmd /c so stderr warnings do not abort under $ErrorActionPreference='Stop'.
    # ALL THREE flags are REQUIRED:
    #   --no-bytecode         : no V8 bytecode. In bytecode mode Function.prototype.toString()
    #                           returns "function () { [native code] }", and puppeteer's
    #                           page.evaluate ships that source to the browser ->
    #                           SyntaxError: Unexpected identifier 'code' (CreateBM & all evaluate break)
    #   --public              : ship top-level package sources too (else only bytecode -> no source error)
    #   --public-packages "*" : same for every node_modules package (tslib etc.)
    & cmd.exe /c "npx -y $PkgSpec . --no-bytecode --public --public-packages * --targets $PKG_TARGET --output ""$pkgOutputPath"" 2>&1" | ForEach-Object { Write-Host "       $_" }

    if ($LASTEXITCODE -ne 0 -or !(Test-Path $pkgOutputPath)) {
        throw "pkg compile failed (exit code: $LASTEXITCODE)"
    }

    $exeSize = [int]((Get-Item $pkgOutputPath).Length / 1MB)
    Write-Host "       + pkg compile done ($exeSize MB)" -ForegroundColor Green
} catch {
    Write-Host "       [ERROR] $($_.Exception.Message)" -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

# ============================================================
# Step 6.5: Create startup batch file alongside the exe
# ============================================================
Write-Host "       Creating start-pup.bat..." -ForegroundColor Cyan

$startBat = @'
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
'@

$startBat | Set-Content (Join-Path $ProjectRoot "start-pup.bat") -Encoding ASCII

# Create data and logs for Inno Setup to pick up
$null = New-Item -ItemType Directory -Path (Join-Path $ProjectRoot "data") -Force -ErrorAction SilentlyContinue
$null = New-Item -ItemType Directory -Path (Join-Path $ProjectRoot "logs") -Force -ErrorAction SilentlyContinue

# ============================================================
# Step 7: Compile Inno Setup Installer
# ============================================================
Write-Host "[7/8] Compiling Inno Setup installer..." -ForegroundColor Cyan

$builtInstaller = $null
if ($isccPath) {
    if (Test-Path $InstallerOutputDir) {
        Remove-Item "$InstallerOutputDir\*.exe" -Force -ErrorAction SilentlyContinue
    } else {
        $null = New-Item -ItemType Directory -Path $InstallerOutputDir -Force
    }

    Push-Location (Join-Path $ProjectRoot "scripts")
    try {
        & cmd.exe /c """$isccPath"" ""$InnoScript"" 2>&1" | ForEach-Object { Write-Host "       $_" }
        if ($LASTEXITCODE -ne 0) {
            throw "Inno Setup compile failed (exit code: $LASTEXITCODE)"
        }
        $builtInstaller = Get-ChildItem -Path $InstallerOutputDir -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($builtInstaller) {
            Write-Host "       + Installer built: $($builtInstaller.FullName)" -ForegroundColor Green
        }
    } catch {
        Write-Host "       [ERROR] $($_.Exception.Message)" -ForegroundColor Red
        Pop-Location
        exit 1
    }
    Pop-Location
} else {
    Write-Host "       ! Inno Setup not installed, skipped installer step." -ForegroundColor Yellow
}

# ============================================================
# Step 8: Clean up staging
# ============================================================
Write-Host "[8/8] Cleaning staging..." -ForegroundColor Cyan
if (Test-Path $StagingPath) {
    Remove-Item $StagingPath -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-Item (Join-Path $ProjectRoot "data") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $ProjectRoot "logs") -Recurse -Force -ErrorAction SilentlyContinue

# ============================================================
# Summary
# ============================================================
Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  Build Complete (v$AppVersion)!" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Cyan
if ($builtInstaller) {
    Write-Host "  Installer: $($builtInstaller.FullName)" -ForegroundColor Cyan
    Write-Host "  Size:      $([int]($builtInstaller.Length / 1MB)) MB"
} else {
    Write-Host "  pkg exe:   $pkgOutputPath" -ForegroundColor Cyan
    Write-Host "  Size:      $([int]((Get-Item $pkgOutputPath).Length / 1MB)) MB"
}
Write-Host ""
Write-Host "  Safety:" -ForegroundColor Green
Write-Host "   + No dev databases (profiles.db / omnifingerprint.db)"
Write-Host "   + No .env, no browser-profiles"
Write-Host "   + Target PC still needs Chrome or Edge installed"
Write-Host "==============================================" -ForegroundColor Cyan
