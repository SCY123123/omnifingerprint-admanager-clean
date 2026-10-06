@echo off
chcp 65001 >nul
title OmniFingerprint PUP 服务器
cd /d "%~dp0"
set LOG_LEVEL=DEBUG
set QUIET_LOGS=false
set PUPPETEER_PORT=9999
set S5_TUNNEL_TYPE=http
echo =============================================
echo  🚀 OmniFingerprint PUP 服务器启动中...
echo  端口: 9999
echo  路径: %CD%
echo =============================================
echo.
node server/puppeteer-api-server.js
echo.
echo 服务器已停止，按任意键关闭...
pause >nul
