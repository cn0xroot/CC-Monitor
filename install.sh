#!/usr/bin/env bash
# 一键安装：把 hooks 注册进 Claude Code + 装好 Web UI 的依赖。
# 用法：
#   ./install.sh                        # hooks 全局安装（写 ~/.claude/settings.json）
#   ./install.sh --project /path        # hooks 只对某个项目生效
#   ./install.sh --skip-geoip           # 不下载 GeoIP 数据库（离线/不需要世界地图时）
#   ./install.sh --skip-ccstatusline    # 不装/不接 ccstatusline 状态栏
#   ./install.sh --agent all            # 同时接入本机装了的 Codex / Gemini CLI / Cursor / OpenCode
#   其它参数跟 install.py 支持的完全一样，原样透传过去（--agent <id> 见 python3 install.py --list）。
#
# One-shot install: register the hooks into Claude Code + install the Web UI deps.
#   ./install.sh                        # global hooks (writes ~/.claude/settings.json)
#   ./install.sh --project /path        # hooks scoped to one project
#   ./install.sh --skip-geoip           # skip the GeoIP database download
#   ./install.sh --skip-ccstatusline    # skip installing/wiring ccstatusline
#   ./install.sh --agent all            # also hook every installed Codex / Gemini CLI / Cursor / OpenCode
#   Any other flag is passed straight through to install.py (--agent <id>; see python3 install.py --list).
set -euo pipefail

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
say_err() { if [ "$CC_LANG" = "zh" ]; then printf '%s\n' "$1" >&2; else printf '%s\n' "$2" >&2; fi; }

# --skip-geoip / --skip-ccstatusline 是这个脚本自己认的，不能透传给 install.py
# （argparse 会报未知参数）。也可以用环境变量 CC_MONITOR_SKIP_GEOIP=1 /
# CC_MONITOR_SKIP_CCSTATUSLINE=1。
SKIP_GEOIP="${CC_MONITOR_SKIP_GEOIP:-}"
SKIP_CCSTATUSLINE="${CC_MONITOR_SKIP_CCSTATUSLINE:-}"
PASSTHRU=()
for arg in "$@"; do
  case "$arg" in
    --skip-geoip) SKIP_GEOIP=1 ;;
    --skip-ccstatusline) SKIP_CCSTATUSLINE=1 ;;
    *) PASSTHRU+=("$arg") ;;
  esac
done
set -- "${PASSTHRU[@]+"${PASSTHRU[@]}"}"

# 不管从哪个目录调用这个脚本，都用脚本自己所在的目录当 REPO_ROOT——
# 不能假设用户是 cd 到这个目录之后才执行的。
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

if ! command -v python3 >/dev/null 2>&1; then
  say_err "[CC-Monitor] 没找到 python3，装完 Python 3 再重跑这个脚本" \
          "[CC-Monitor] python3 not found — install Python 3 and run this script again"
  exit 1
fi

say "[CC-Monitor] 1/5 ccstatusline（终端状态栏，显示模型/额度/git 分支等）..." \
    "[CC-Monitor] 1/5 ccstatusline (terminal status line: model / quota / git branch)..."
# 先装包，装完 install.py 那一步才能检测到 `ccstatusline` 命令、把它接进 statusLine
# 配置——顺序不能反。两层都做"已经有就跳过"：这里检查命令是否已经在 PATH 上（不管是
# 这个脚本之前装的还是用户自己装的），装过就不重复装/升级；接不接进 statusLine 配置
# 由 install.py 的 configure_statusline() 再检查一遍 settings.json 里有没有 statusLine
# 键，两边各自幂等，不会把用户已有的定制覆盖掉。
if [ -n "$SKIP_CCSTATUSLINE" ]; then
  say "[CC-Monitor] 跳过 ccstatusline（--skip-ccstatusline）。" \
      "[CC-Monitor] Skipping ccstatusline (--skip-ccstatusline)."
elif command -v ccstatusline >/dev/null 2>&1; then
  say "[CC-Monitor] 已检测到 ccstatusline，跳过安装（下一步会检查要不要接进 statusLine 配置）。" \
      "[CC-Monitor] ccstatusline already present, skipping install (the next step checks the statusLine wiring)."
elif command -v npm >/dev/null 2>&1; then
  if npm install -g ccstatusline; then
    say "[CC-Monitor] ccstatusline 安装完成。" "[CC-Monitor] ccstatusline installed."
  else
    say_err "[CC-Monitor] ccstatusline 安装失败（网络问题？）。这是可选功能，不影响其它部分，之后可以手动: npm install -g ccstatusline" \
            "[CC-Monitor] ccstatusline install failed (network?). It's optional and affects nothing else; you can run 'npm install -g ccstatusline' later."
  fi
else
  say_err "[CC-Monitor] 没找到 npm，跳过 ccstatusline 安装（可选功能，不影响主功能）。" \
          "[CC-Monitor] npm not found, skipping ccstatusline (optional, nothing else is affected)."
fi

echo
say "[CC-Monitor] 2/5 注册 hooks 到 Claude Code..." \
    "[CC-Monitor] 2/5 Registering hooks into Claude Code..."
if [ -n "$SKIP_CCSTATUSLINE" ]; then
  python3 install.py "$@" --skip-statusline
else
  python3 install.py "$@"
fi

echo
say "[CC-Monitor] 3/5 安装 Web UI 依赖..." "[CC-Monitor] 3/5 Installing Web UI dependencies..."
if command -v npm >/dev/null 2>&1; then
  (cd webui && npm install)
else
  say_err "[CC-Monitor] 没找到 npm，跳过 Web UI 依赖安装——只想用 CLI（tail/rules/stats/verify/tap）的话不影响；想用 Web UI 的话装好 Node.js/npm 后手动跑一次: cd webui && npm install" \
          "[CC-Monitor] npm not found, skipping Web UI dependencies — fine if you only want the CLI (tail/rules/stats/verify/tap). For the Web UI, install Node.js/npm and run: cd webui && npm install"
fi

echo
if [ "$(uname -s)" = "Darwin" ]; then
  say "[CC-Monitor] 4/5 macOS：系统层探针用系统自带的 nettop，不用装东西，直接 bin/CC-Monitor-probe（不需要 sudo）。" \
      "[CC-Monitor] 4/5 macOS: the system-layer probe uses the built-in nettop — nothing to install, just run bin/CC-Monitor-probe (no sudo needed)."
elif command -v bpftrace >/dev/null 2>&1; then
  say "[CC-Monitor] 4/5 检测到 bpftrace，系统层探针（CC-Monitor-probe）可以直接用。" \
      "[CC-Monitor] 4/5 bpftrace detected — the system-layer probe (CC-Monitor-probe) is ready to use."
else
  say "[CC-Monitor] 4/5 没检测到 bpftrace（系统层探针是可选的，跳过不影响主功能）。" \
      "[CC-Monitor] 4/5 bpftrace not found (the system-layer probe is optional; skipping affects nothing else)."
  say "             想用的话：Debian/Ubuntu 用 'sudo apt install bpftrace'，其它发行版参考 bpftrace 官方文档。" \
      "             To enable it: 'sudo apt install bpftrace' on Debian/Ubuntu, or see the bpftrace docs for your distro."
fi

echo
# GeoIP 数据库：网络流量页的归属地列和世界地图靠它，不随仓库分发（几十 MB，且许可证
# 要求单独获取）。默认下载 DB-IP Lite（CC BY 4.0，不用注册账号）的 IPv4 city 库，来源是
# sapics/ip-location-db 每日自动转出的 .mmdb。已经有任何一个能用的库（包括自己放的
# MaxMind GeoLite2）就不重复下；下载失败只是提示，不中断安装——这是可选功能。
# 也可以用 CC_MONITOR_SKIP_GEOIP=1 / --skip-geoip 跳过。
GEOIP_DIR="${CC_MONITOR_HOME:-$HOME/.cc-monitor}"
GEOIP_TARGET="$GEOIP_DIR/dbip-city.mmdb"
# 下载地址可以用 CC_MONITOR_GEOIP_URL 换成镜像（比如 GitHub 访问不畅的时候）。
GEOIP_URL="${CC_MONITOR_GEOIP_URL:-https://github.com/sapics/ip-location-db/releases/download/latest/dbip-city-ipv4.mmdb}"
if [ -n "$SKIP_GEOIP" ]; then
  say "[CC-Monitor] 5/5 跳过 GeoIP 数据库下载（--skip-geoip）。" \
      "[CC-Monitor] 5/5 Skipping the GeoIP database download (--skip-geoip)."
elif [ -f "$GEOIP_TARGET" ] || [ -f "$GEOIP_DIR/GeoLite2-City.mmdb" ] || [ -f "$GEOIP_DIR/GeoLite2-Country.mmdb" ]; then
  say "[CC-Monitor] 5/5 GeoIP 数据库已存在（$GEOIP_DIR 下已有 .mmdb），跳过下载。" \
      "[CC-Monitor] 5/5 A GeoIP database is already present (.mmdb found in $GEOIP_DIR), skipping the download."
else
  say "[CC-Monitor] 5/5 下载 GeoIP 数据库（DB-IP Lite，约 60MB）到 $GEOIP_TARGET ..." \
      "[CC-Monitor] 5/5 Downloading the GeoIP database (DB-IP Lite, ~60MB) to $GEOIP_TARGET ..."
  mkdir -p "$GEOIP_DIR"
  GEOIP_TMP="$GEOIP_TARGET.part"
  geoip_ok=""
  if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar --retry 2 --connect-timeout 15 -m 600 -o "$GEOIP_TMP" "$GEOIP_URL" && geoip_ok=1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 15 -t 2 -O "$GEOIP_TMP" "$GEOIP_URL" && geoip_ok=1
  else
    say_err "[CC-Monitor] 没找到 curl 或 wget，没法自动下载。" \
            "[CC-Monitor] Neither curl nor wget found — cannot download automatically."
  fi
  # 空文件/半截文件不能留着——geoip.js 打开一个坏 mmdb 会静默失败，页面上看起来像"没配置"，
  # 比没有文件还难排查。正常的库有几十 MB，小于 1MB 一律当下载失败。
  GEOIP_SIZE=$(( $(wc -c < "$GEOIP_TMP" 2>/dev/null || echo 0) ))  # macOS 的 wc 带前导空格，算术展开顺手去掉
  if [ -n "$geoip_ok" ] && [ "$GEOIP_SIZE" -gt 1000000 ]; then
    mv -f "$GEOIP_TMP" "$GEOIP_TARGET"
    say "[CC-Monitor] GeoIP 数据库已就绪: $GEOIP_TARGET" \
        "[CC-Monitor] GeoIP database ready: $GEOIP_TARGET"
  else
    rm -f "$GEOIP_TMP"
    say_err "[CC-Monitor] GeoIP 数据库下载失败（网络不通/被墙？）。这是可选功能，不影响其它部分。" \
            "[CC-Monitor] GeoIP database download failed (network issues?). It's optional and affects nothing else."
    say_err "             之后可以手动下载: curl -L -o $GEOIP_TARGET $GEOIP_URL" \
            "             You can download it later: curl -L -o $GEOIP_TARGET $GEOIP_URL"
    say_err "             或者用 MaxMind GeoLite2，放到 $GEOIP_DIR/GeoLite2-City.mmdb" \
            "             Or use MaxMind GeoLite2 and place it at $GEOIP_DIR/GeoLite2-City.mmdb"
  fi
fi

echo
echo "======================================================================"
say " 安装完成。接下来：" " Installation complete. Next steps:"
say "  1. 重启 Claude Code（新开的会话才会读到刚写进去的 hooks 配置）" \
    "  1. Restart Claude Code (only new sessions pick up the hooks config just written)"
say "  2. 想用 Web UI 的话运行: ./start.sh" \
    "  2. For the Web UI, run: ./start.sh"
echo "======================================================================"
