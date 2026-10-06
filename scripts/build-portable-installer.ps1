#Requires -Version 5.1

<#
.SYNOPSIS
    OmniFingerprint PUP Server Installer Builder (Portable Node.js)
.DESCRIPTION
    Builds a Windows .exe installer by bundling portable Node.js + server code.
    - Downloads Node.js portable (no install needed)
    - Copies server source code + node_modules
    - Excludes all sensitive development data (.db, .env, browser-profiles)
    - Creates Inno Setup installer
    - Target machine needs NO Node.js, just Google Chrome
#>

$ErrorActionPreference = 'Stop'
$ProjectRoot = Get-Location

# ---- Configuration ----
$BuildName = "pup-server-build"
$BuildPath = Join-Path $ProjectRoot $BuildName
$ServerNodeModules = Join-Path $ProjectRoot "server\node_modules"
$InstallerOutputDir = Join-Path $ProjectRoot "installer-output"
$InnoScript = Join-Path $ProjectRoot "scripts\pup-installer.iss"

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  OmniFingerprint PUP Installer Builder" -ForegroundColor Cyan
Write-Host "  便携 Node.js + 源码 => .exe 安装包" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================
# Step 1: Clean build directory
# ============================================================
Write-Host "[1/7] 清理构建目录..." -ForegroundColor Cyan
if (Test-Path $BuildPath) {
    # Use robocopy to empty it (avoid symlink issues with Remove-Item -Recurse)
    $emptyDir = Join-Path $ProjectRoot ".empty-temp"
    if (-not (Test-Path $emptyDir)) { $null = New-Item $emptyDir -ItemType Directory -Force }
    robocopy $emptyDir $BuildPath /MIR /NFL /NDL /NJH /NJS /nc /ns /np 2>$null
    Remove-Item $BuildPath -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $emptyDir -Recurse -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1000
}
$null = New-Item $BuildPath -ItemType Directory -Force
Write-Host "       构建目录已创建: $BuildPath" -ForegroundColor Green

# ============================================================
# Step 2: Download portable Node.js
# ============================================================
Write-Host "[2/7] 下载 Node.js 便携版..." -ForegroundColor Cyan

$nodeDir = Join-Path $BuildPath "node"
$nodeZip = Join-Path $ProjectRoot ".node-portable.zip"
$nodeUrl = "https://nodejs.org/dist/v22.16.0/node-v22.16.0-win-x64.zip"

if (-not (Test-Path (Join-Path $nodeDir "node.exe"))) {
    Write-Host "       正在下载 Node.js v22.16.0 (约 40MB)..." -ForegroundColor Yellow
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $webClient = New-Object System.Net.WebClient
        $webClient.DownloadFile($nodeUrl, $nodeZip)
        Write-Host "       下载完成，正在解压..." -ForegroundColor Yellow
        
        # Extract ZIP
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [System.IO.Compression.ZipFile]::OpenRead($nodeZip)
        # Extract just the files from the inner "node-v22.16.0-win-x64" folder
        $zip.Entries | Where-Object { $_.FullName -match "^node-v22.16.0-win-x64/" -and $_.FullName -ne "node-v22.16.0-win-x64/" } | ForEach-Object {
            $targetPath = Join-Path $nodeDir $_.FullName.Replace("node-v22.16.0-win-x64/", "")
            $parentDir = Split-Path $targetPath -Parent
            if (-not (Test-Path $parentDir)) { $null = New-Item $parentDir -ItemType Directory -Force }
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($_, $targetPath, $true)
        }
        $zip.Dispose()
        Remove-Item $nodeZip -Force -ErrorAction SilentlyContinue
        Write-Host "       Node.js 便携版已就绪" -ForegroundColor Green
    } catch {
        Write-Host "       [WARN] 下载失败: $_" -ForegroundColor Red
        Write-Host "       请手动下载后重试: $nodeUrl" -ForegroundColor Yellow
        Write-Host "       下载后解压到: $nodeDir" -ForegroundColor Yellow
        Write-Host "       继续使用系统中已安装的 Node.js..." -ForegroundColor Yellow
        
        # Fallback: copy current node.exe
        $nodeExePath = (Get-Command node).Source
        if ($nodeExePath) {
            $null = New-Item $nodeDir -ItemType Directory -Force
            Copy-Item $nodeExePath (Join-Path $nodeDir "node.exe") -Force
            Write-Host "       已复制当前系统的 node.exe（缺少 npm，但可运行）" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "       Node.js 便携版已存在，跳过下载" -ForegroundColor Green
}

# Verify
if (Test-Path (Join-Path $nodeDir "node.exe")) {
    $nodeVer = & (Join-Path $nodeDir "node.exe") --version 2>&1
    Write-Host "       Node.js 版本: $nodeVer" -ForegroundColor Green
} else {
    Write-Host "       [WARN] node.exe 未找到，后续步骤可能失败" -ForegroundColor Red
}

# ============================================================
# Step 3: Copy server source files (NO databases, NO .env, NO browser-profiles)
# ============================================================
Write-Host "[3/7] 复制服务端源码文件（已排除敏感数据）..." -ForegroundColor Cyan

$serverDir = Join-Path $BuildPath "server"
$null = New-Item $serverDir -ItemType Directory -Force
$null = New-Item (Join-Path $serverDir "payment") -ItemType Directory -Force
$null = New-Item (Join-Path $serverDir "integrations") -ItemType Directory -Force
$null = New-Item (Join-Path $serverDir "data") -ItemType Directory -Force
$null = New-Item (Join-Path $serverDir "logs") -ItemType Directory -Force

$coreFiles = @(
    "server\puppeteer-api-server.js",
    "server\google-ads-service.js",
    "server\payment\token-provider.js",
    "server\integrations\adpos-client.js",
    "server\package.json"
)
foreach ($f in $coreFiles) {
    $src = Join-Path $ProjectRoot $f
    $dst = Join-Path $serverDir (Split-Path $f -Leaf)
    if ($f -match "\\(.+)\\(.+)$") {
        # File is in subdirectory
        $subDir = $matches[1]
        $fileName = $matches[2]
        $dst = Join-Path (Join-Path $serverDir $subDir) $fileName
    } elseif ($f -match "\\([^\\]+)$") {
        $dst = Join-Path $serverDir $matches[1]
    }
    if (Test-Path $src) {
        Copy-Item $src $dst -Force
        Write-Host "       Copied: $f"
    }
}

Write-Host "       ✅ 已排除: *.db / *.sqlite / .env* / browser-profiles" -ForegroundColor Green
Write-Host "       源码复制完成" -ForegroundColor Green

# ============================================================
# Step 4: Copy node_modules (excluding problematic symlink)
# ============================================================
Write-Host "[4/7] 复制 node_modules..." -ForegroundColor Cyan

$dstModules = Join-Path $serverDir "node_modules"
if (Test-Path $ServerNodeModules) {
    Write-Host "       正在复制（这可能需要几分钟）..." -ForegroundColor Yellow
    robocopy $ServerNodeModules $dstModules /E /XD omnifingerprint-admanager /NFL /NDL /NJH /NJS /nc /ns /np
    Write-Host "       node_modules 复制完成（已排除本地依赖符号链接）" -ForegroundColor Green
} else {
    Write-Host "       [WARN] node_modules 不存在，稍后运行 npm install..." -ForegroundColor Yellow
    Push-Location $serverDir
    npm install --production
    Pop-Location
}

# ============================================================
# Step 5: Create startup script
# ============================================================
Write-Host "[5/7] 创建启动脚本..." -ForegroundColor Cyan

$startBat = @'
@echo off
chcp 65001 >nul
title OmniFingerprint-PUP-Server
cd /d "%~dp0"

:: ========== 配置项（按需修改） ==========
set PUPPETEER_PORT=9999
set LOG_LEVEL=INFO
set QUIET_LOGS=false
set AUTO_CLICK_VERIFY=true
set PUPPETEER_API_SECRET=your_local_secret_here
set STORAGE_SERVER_URL=https://your-backend.example.com
:: ======================================

echo =============================================
echo   OmniFingerprint PUP Server
echo   本机无需安装 Node.js
echo   Port: %PUPPETEER_PORT%
echo =============================================
echo.

:: 验证 node.exe
if not exist "%~dp0node\node.exe" (
    echo [ERROR] node.exe 未找到！
    echo        请重新安装本程序。
    pause
    exit /b 1
)

:: 验证服务端文件
if not exist "%~dp0server\puppeteer-api-server.js" (
    echo [ERROR] 服务端文件缺失！
    echo        请重新安装本程序。
    pause
    exit /b 1
)

:: 确保数据目录存在
if not exist "%~dp0server\data\" mkdir "%~dp0server\data"
if not exist "%~dp0server\logs\" mkdir "%~dp0server\logs"

:: 自动检测 Chrome（如果未设置 CHROME_PATH）
if not defined CHROME_PATH (
    set "CHROME_LIST=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    set "CHROME_LIST=%CHROME_LIST%;%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    set "CHROME_LIST=%CHROME_LIST%;%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    set "CHROME_LIST=%CHROME_LIST%;%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    set "CHROME_LIST=%CHROME_LIST%;%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
    set "CHROME_LIST=%CHROME_LIST%;%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"

    for %%c in (%CHROME_LIST%) do (
        if exist "%%c" (
            echo [INFO] 检测到浏览器: %%c
            set "CHROME_PATH=%%c"
            goto :CHROME_FOUND
        )
    )
    echo [WARN] 未检测到 Chrome/Edge
) else (
    echo [INFO] CHROME_PATH=%CHROME_PATH%
)
:CHROME_FOUND

echo [INFO] 启动 PUP Server ...
echo.

cd server
"%~dp0node\node.exe" puppeteer-api-server.js

echo.
echo [INFO] 服务器已停止。
pause >nul
'@

$startBatPath = Join-Path $BuildPath "start-pup.bat"
$startBat | Set-Content $startBatPath -Encoding Ascii
Write-Host "       启动脚本已创建: start-pup.bat" -ForegroundColor Green

# ============================================================
# Step 6: Create/Update Inno Setup script
# ============================================================
Write-Host "[6/7] 准备 Inno Setup 安装包脚本..." -ForegroundColor Cyan

# Check if ISCC exists
$isccFound = $false
$isccPaths = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 5\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 6\ISCC.exe"
)
foreach ($p in $isccPaths) {
    if (Test-Path $p) { $isccFound = $true; $isccPath = $p; break }
}

if ($isccFound) {
    Write-Host "       Inno Setup Compiler 已就绪: $isccPath" -ForegroundColor Green
    
    $installerScript = Join-Path $BuildPath "installer.iss"
    @"
; OmniFingerprint PUP Server Installer
#define MyAppName "OmniFingerprint PUP Server"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "OmniFingerprint"
#define MyAppExeName "start-pup.bat"

[Setup]
AppId={{B8F4A3D1-2C5E-4A7B-9F6D-8E1C3A5B7D9F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\OmniFingerprint\PUP-Server
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir={#MyAppOutputDir}
OutputBaseFilename=OmniFingerprint-PUP-Server-{#MyAppArch}-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\node\node.exe
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: checkedonce

[Files]
Source: "{#MyAppBuildDir}\node\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#MyAppBuildDir}\server\*"; DestDir: "{app}\server"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#MyAppBuildDir}\start-pup.bat"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent shellexec
"@ | Set-Content $installerScript -Encoding UTF8

    # Compile
    Write-Host "       正在编译安装包（这可能需要几分钟）..." -ForegroundColor Yellow
    Push-Location $BuildPath
    & $isccPath $installerScript 2>&1 | ForEach-Object { Write-Host "       $_" }
    Pop-Location
    
    # Find installer
    $installer = Get-ChildItem -Path $InstallerOutputDir -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($installer) {
        Write-Host "       ✅ 安装包创建完成!" -ForegroundColor Green
        Write-Host "       文件: $($installer.FullName)" -ForegroundColor Green
        Write-Host "       大小: $($installer.Length / 1MB -as [int]) MB" -ForegroundColor Green
    }
} else {
    Write-Host "       ⚠️  Inno Setup 未安装，跳过安装包编译。" -ForegroundColor Yellow
    Write-Host "       构建产物已准备就绪: $BuildPath" -ForegroundColor Yellow
    Write-Host "       请安装 Inno Setup 后手动编译安装包:" -ForegroundColor Yellow
    Write-Host '       & "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" scripts\pup-installer.iss' -ForegroundColor Yellow
}

# ============================================================
# Step 7: Clean up empty temp directory
# ============================================================
Write-Host "[7/7] 清理临时文件..." -ForegroundColor Cyan
$emptyDir = Join-Path $ProjectRoot ".empty-temp"
Remove-Item $emptyDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "       清理完成" -ForegroundColor Green

# ============================================================
# Summary
# ============================================================
Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  ✅ 构建完成！" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Cyan

if ($isccFound -and (Get-ChildItem $InstallerOutputDir -Filter "*.exe" | Select-Object -First 1)) {
    $installerFile = Get-ChildItem $InstallerOutputDir -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Write-Host "  📦 安装包: $($installerFile.FullName)"
    Write-Host "     大小: $($installerFile.Length / 1MB -as [int]) MB"
    Write-Host ""
    Write-Host "  使用方法:" -ForegroundColor Cyan
    Write-Host "    1. 将安装包发给目标用户"
    Write-Host "    2. 用户双击安装，一路 Next"
    Write-Host "    3. 安装完成后，从桌面快捷方式启动"
} else {
    Write-Host "  📁 构建目录: $BuildPath"
    Write-Host "     可直接拷贝到目标电脑运行 start-pup.bat"
    Write-Host ""
    Write-Host "  如需制作安装包，请安装 Inno Setup:" -ForegroundColor Yellow
    Write-Host "  https://jrsoftware.org/isdl.php" -ForegroundColor Yellow
    Write-Host '  然后运行: & "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" scripts\pup-installer.iss' -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  🔒 安全说明:" -ForegroundColor Green
Write-Host "     ✅ 不含开发数据库 (profiles.db / omnifingerprint.db)"
Write-Host "     ✅ 不含 .env 环境变量"
Write-Host "     ✅ 不含 browser-profiles"
Write-Host "     ✅ 用户首次运行自动创建空数据库"
Write-Host ""
Write-Host "  ⚠️  目标电脑仍需:" -ForegroundColor Yellow
Write-Host "     - Google Chrome 或 Edge 浏览器（自动识别）"
Write-Host "==============================================" -ForegroundColor Cyan
