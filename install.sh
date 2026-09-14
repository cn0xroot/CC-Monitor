#!/usr/bin/env bash
# 一键安装：把 hooks 注册进 Claude Code + 装好 Web UI 的依赖。
# 用法：
#   ./install.sh                    # hooks 全局安装（写 ~/.claude/settings.json）
#   ./install.sh --project /path    # hooks 只对某个项目生效
#   ./install.sh --skip-geoip       # 不下载 GeoIP 数据库（离线/不需要世界地图时）
#   其它参数跟 install.py 支持的完全一样，原样透传过去。
set -euo pipefail

# --skip-geoip 是这个脚本自己认的，不能透传给 install.py（argparse 会报未知参数）。
# 也可以用环境变量 CC_MONITOR_SKIP_GEOIP=1。
SKIP_GEOIP="${CC_MONITOR_SKIP_GEOIP:-}"
PASSTHRU=()
for arg in "$@"; do
  if [ "$arg" = "--skip-geoip" ]; then
    SKIP_GEOIP=1
  else
    PASSTHRU+=("$arg")
  fi
done
set -- "${PASSTHRU[@]+"${PASSTHRU[@]}"}"

# 不管从哪个目录调用这个脚本，都用脚本自己所在的目录当 REPO_ROOT——
# 不能假设用户是 cd 到这个目录之后才执行的。
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[CC-Monitor] 没找到 python3，装完 Python 3 再重跑这个脚本" >&2
  exit 1
fi

echo "[CC-Monitor] 1/4 注册 hooks 到 Claude Code..."
python3 install.py "$@"

echo
echo "[CC-Monitor] 2/4 安装 Web UI 依赖..."
if command -v npm >/dev/null 2>&1; then
  (cd webui && npm install)
else
  echo "[CC-Monitor] 没找到 npm，跳过 Web UI 依赖安装——只想用 CLI（tail/rules/stats/verify/tap）的话不影响；" \
       "想用 Web UI 的话装好 Node.js/npm 后手动跑一次: cd webui && npm install" >&2
fi

echo
if [ "$(uname -s)" = "Darwin" ]; then
  echo "[CC-Monitor] 3/4 macOS：系统层探针用系统自带的 nettop，不用装东西，直接 bin/CC-Monitor-probe（不需要 sudo）。"
elif command -v bpftrace >/dev/null 2>&1; then
  echo "[CC-Monitor] 3/4 检测到 bpftrace，系统层探针（CC-Monitor-probe）可以直接用。"
else
  echo "[CC-Monitor] 3/4 没检测到 bpftrace（系统层探针是可选的，跳过不影响主功能）。"
  echo "             想用的话：Debian/Ubuntu 用 'sudo apt install bpftrace'，其它发行版参考 bpftrace 官方文档。"
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
  echo "[CC-Monitor] 4/4 跳过 GeoIP 数据库下载（--skip-geoip）。"
elif [ -f "$GEOIP_TARGET" ] || [ -f "$GEOIP_DIR/GeoLite2-City.mmdb" ] || [ -f "$GEOIP_DIR/GeoLite2-Country.mmdb" ]; then
  echo "[CC-Monitor] 4/4 GeoIP 数据库已存在（$GEOIP_DIR 下已有 .mmdb），跳过下载。"
else
  echo "[CC-Monitor] 4/4 下载 GeoIP 数据库（DB-IP Lite，约 60MB）到 $GEOIP_TARGET ..."
  mkdir -p "$GEOIP_DIR"
  GEOIP_TMP="$GEOIP_TARGET.part"
  geoip_ok=""
  if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar --retry 2 --connect-timeout 15 -m 600 -o "$GEOIP_TMP" "$GEOIP_URL" && geoip_ok=1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 15 -t 2 -O "$GEOIP_TMP" "$GEOIP_URL" && geoip_ok=1
  else
    echo "[CC-Monitor] 没找到 curl 或 wget，没法自动下载。" >&2
  fi
  # 空文件/半截文件不能留着——geoip.js 打开一个坏 mmdb 会静默失败，页面上看起来像"没配置"，
  # 比没有文件还难排查。正常的库有几十 MB，小于 1MB 一律当下载失败。
  GEOIP_SIZE=$(( $(wc -c < "$GEOIP_TMP" 2>/dev/null || echo 0) ))  # macOS 的 wc 带前导空格，算术展开顺手去掉
  if [ -n "$geoip_ok" ] && [ "$GEOIP_SIZE" -gt 1000000 ]; then
    mv -f "$GEOIP_TMP" "$GEOIP_TARGET"
    echo "[CC-Monitor] GeoIP 数据库已就绪: $GEOIP_TARGET"
  else
    rm -f "$GEOIP_TMP"
    echo "[CC-Monitor] GeoIP 数据库下载失败（网络不通/被墙？）。这是可选功能，不影响其它部分。" >&2
    echo "             之后可以手动下载: curl -L -o $GEOIP_TARGET $GEOIP_URL" >&2
    echo "             或者用 MaxMind GeoLite2，放到 $GEOIP_DIR/GeoLite2-City.mmdb" >&2
  fi
fi

echo
echo "======================================================================"
echo " 安装完成。接下来："
echo "  1. 重启 Claude Code（新开的会话才会读到刚写进去的 hooks 配置）"
echo "  2. 想用 Web UI 的话运行: ./start.sh"
echo "======================================================================"
