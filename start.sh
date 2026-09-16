#!/usr/bin/env bash
# 一键启动 Web UI：没装依赖会先自动装一次，然后前台跑起来（Ctrl+C 停止）。
# 想后台跑：nohup ./start.sh > /tmp/cc-monitor-webui.log 2>&1 &
#
# Start the Web UI: installs dependencies on first run, then runs in the
# foreground (Ctrl+C to stop). Background: nohup ./start.sh > /tmp/log 2>&1 &
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------- 语言检测 / language detection ----------
# 提示信息按系统语言输出：中文环境给中文，其它一律英文。
# 优先级：CC_MONITOR_LANG 显式指定 > LC_ALL / LC_MESSAGES / LANG > macOS 系统区域。
# macOS 从图形界面打开的终端经常压根不设 LANG，所以要额外问一次 AppleLocale，
# 不然中文用户在 mac 上会看到英文。
_cc_detect_lang() {
  case "${CC_MONITOR_LANG:-}" in
    zh*) printf 'zh'; return ;;
    en*) printf 'en'; return ;;
  esac
  local loc="${LC_ALL:-}"
  [ -z "$loc" ] && loc="${LC_MESSAGES:-}"
  [ -z "$loc" ] && loc="${LANG:-}"
  if [ -z "$loc" ] && [ "$(uname -s)" = "Darwin" ] && command -v defaults >/dev/null 2>&1; then
    loc="$(defaults read -g AppleLocale 2>/dev/null || true)"
  fi
  case "$loc" in
    zh*|*_CN*|*_TW*|*_HK*|*Hans*|*Hant*) printf 'zh' ;;
    *) printf 'en' ;;
  esac
}
CC_LANG="$(_cc_detect_lang)"

# say <中文> <English> —— 按当前语言选一条输出；say_err 同理但走 stderr
say() { if [ "$CC_LANG" = "zh" ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }

cd "$REPO_ROOT/webui"

# Web UI 和 cc_monitor 的 hook 各自按"当前进程的操作系统用户"算自己的 ~/.cc-monitor/
# 目录——如果这里用 sudo/root 启动，但你平时在终端里是用自己的普通账号跑 claude，
# 两边写的是完全不相干的两个 SQLite 数据库：终端里的确认框、审计事件，Web UI 的
# "待批准"/审计日志页面永远看不到。只是提醒，不强制退出（真要两边都用 root 跑也行）。
if [ "$(id -u)" -eq 0 ] && [ -z "${CC_MONITOR_ALLOW_ROOT:-}" ]; then
  say "[CC-Monitor] 警告：正在用 root 启动 Web UI。如果你平时跑 claude 用的是普通账号，" \
      "[CC-Monitor] Warning: starting the Web UI as root. If you normally run claude as a regular user,"
  say "             两边会各写各的 ~/.cc-monitor/ 数据库，互相看不到彼此。" \
      "             each side writes its own ~/.cc-monitor/ database and neither can see the other."
  say "             建议改用你平时跑 claude 的那个账号启动（比如 sudo -u <你的用户名> ./start.sh）。" \
      "             Prefer starting it as that user (e.g. sudo -u <your-username> ./start.sh)."
  say "             确认就是要用 root（比如 claude 本来就是 root 跑的），设 CC_MONITOR_ALLOW_ROOT=1 消除这条提示。" \
      "             If root is intended (claude also runs as root), set CC_MONITOR_ALLOW_ROOT=1 to silence this."
fi

if [ ! -d node_modules ]; then
  say "[CC-Monitor] 还没装过依赖，先跑一次 npm install..." \
      "[CC-Monitor] Dependencies not installed yet, running npm install first..."
  npm install
fi

say "[CC-Monitor] 启动 Web UI..." "[CC-Monitor] Starting the Web UI..."
exec node server.js
