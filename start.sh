#!/usr/bin/env bash
# 一键启动 Web UI：没装依赖会先自动装一次，然后前台跑起来（Ctrl+C 停止）。
# 想后台跑：nohup ./start.sh > /tmp/cc-monitor-webui.log 2>&1 &
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT/webui"

if [ ! -d node_modules ]; then
  echo "[CC-Monitor] 还没装过依赖，先跑一次 npm install..."
  npm install
fi

echo "[CC-Monitor] 启动 Web UI..."
exec node server.js
