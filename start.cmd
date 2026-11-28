@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo 需要先安装 Node.js 24 或更高版本：winget install OpenJS.NodeJS & pause & exit /b 1)
where claude >nul 2>nul || if "%COSYEE_CLAUDE%"=="" (echo 找不到 claude 命令：先安装并登录 Claude Code CLI & pause & exit /b 1)
rem 默认 Tailscale 模式：本机和 tailnet 内的设备可访问，局域网 / 公网连不上。只给本机用可改成 127.0.0.1
if "%COSYEE_HOST%"=="" set COSYEE_HOST=tailscale
node server.mjs
pause
