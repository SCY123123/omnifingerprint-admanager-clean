@echo off
chcp 65001 >nul
title OmniFingerprint PUP 安装包编译
cd /d "%~dp0"

echo =============================================
echo  OmniFingerprint PUP 客户端 - 安装包编译
echo =============================================
echo.

:: 检查 Inno Setup
set ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe
if not exist "%ISCC%" (
    echo [错误] 未找到 Inno Setup 6
    echo 请先安装: https://jrsoftware.org/isdl.php
    pause
    exit /b 1
)

:: 检查 pup-client 是否已构建
if not exist "pup-client\node\node.exe" (
    echo [错误] 未找到 pup-client 目录，请先运行: npm run build:pup
    pause
    exit /b 1
)

:: 确保输出目录存在
if not exist "installer-output" mkdir "installer-output"

echo [信息] 开始编译安装包...
echo [信息] 正在压缩 ~500MB 数据，预计 5-15 分钟...
echo.

:: 运行 Inno Setup 编译
"%ISCC%" installer.iss

if %ERRORLEVEL% EQU 0 (
    echo.
    echo =============================================
    echo  ✅ 安装包编译成功!
    echo  输出目录: installer-output\
    echo =============================================
) else (
    echo.
    echo  ❌ 编译失败 (错误码: %ERRORLEVEL%)
)

echo.
pause
