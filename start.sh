#!/usr/bin/env bash
# 一键启动 Web UI：没装依赖会先自动装一次，然后前台跑起来（Ctrl+C 停止）。
# 想后台跑：nohup ./start.sh > /tmp/cc-monitor-webui.log 2>&1 &
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT/webui"

# Web UI 和 cc_monitor 的 hook 各自按"当前进程的操作系统用户"算自己的 ~/.cc-monitor/
# 目录——如果这里用 sudo/root 启动，但你平时在终端里是用自己的普通账号跑 claude，
# 两边写的是完全不相干的两个 SQLite 数据库：终端里的确认框、审计事件，Web UI 的
# "待批准"/审计日志页面永远看不到。只是提醒，不强制退出（真要两边都用 root 跑也行）。
if [ "$(id -u)" -eq 0 ] && [ -z "${CC_MONITOR_ALLOW_ROOT:-}" ]; then
  echo "[CC-Monitor] 警告：正在用 root 启动 Web UI。如果你平时跑 claude 用的是普通账号，"
  echo "             两边会各写各的 ~/.cc-monitor/ 数据库，互相看不到彼此。"
  echo "             建议改用你平时跑 claude 的那个账号启动（比如 sudo -u <你的用户名> ./start.sh）。"
  echo "             确认就是要用 root（比如 claude 本来就是 root 跑的），设 CC_MONITOR_ALLOW_ROOT=1 消除这条提示。"
fi

if [ ! -d node_modules ]; then
  echo "[CC-Monitor] 还没装过依赖，先跑一次 npm install..."
  npm install
fi

echo "[CC-Monitor] 启动 Web UI..."
exec node server.js
