#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js 24 或更高版本"; exit 1; }
if [ -z "$COSYEE_CLAUDE" ] && ! command -v claude >/dev/null 2>&1; then echo "找不到 claude 命令：先安装并登录 Claude Code CLI"; exit 1; fi
# 默认 Tailscale 模式：本机和 tailnet 内的设备可访问，局域网 / 公网连不上。只给本机用可改成 127.0.0.1
export COSYEE_HOST="${COSYEE_HOST:-tailscale}"
exec node server.mjs
