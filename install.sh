#!/usr/bin/env bash
# 一键安装：把 hooks 注册进 Claude Code + 装好 Web UI 的依赖。
# 用法：
#   ./install.sh                    # hooks 全局安装（写 ~/.claude/settings.json）
#   ./install.sh --project /path    # hooks 只对某个项目生效
#   跟 install.py 支持的参数完全一样，原样透传过去。
set -euo pipefail

# 不管从哪个目录调用这个脚本，都用脚本自己所在的目录当 REPO_ROOT——
# 不能假设用户是 cd 到这个目录之后才执行的。
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[CC-Monitor] 没找到 python3，装完 Python 3 再重跑这个脚本" >&2
  exit 1
fi

echo "[CC-Monitor] 1/3 注册 hooks 到 Claude Code..."
python3 install.py "$@"

echo
echo "[CC-Monitor] 2/3 安装 Web UI 依赖..."
if command -v npm >/dev/null 2>&1; then
  (cd webui && npm install)
else
  echo "[CC-Monitor] 没找到 npm，跳过 Web UI 依赖安装——只想用 CLI（tail/rules/stats/verify/tap）的话不影响；" \
       "想用 Web UI 的话装好 Node.js/npm 后手动跑一次: cd webui && npm install" >&2
fi

echo
if command -v bpftrace >/dev/null 2>&1; then
  echo "[CC-Monitor] 3/3 检测到 bpftrace，系统层探针（CC-Monitor-probe）可以直接用。"
else
  echo "[CC-Monitor] 3/3 没检测到 bpftrace（系统层探针是可选的，跳过不影响主功能）。"
  echo "             想用的话：Debian/Ubuntu 用 'sudo apt install bpftrace'，其它发行版参考 bpftrace 官方文档。"
fi

echo
echo "======================================================================"
echo " 安装完成。接下来："
echo "  1. 重启 Claude Code（新开的会话才会读到刚写进去的 hooks 配置）"
echo "  2. 想用 Web UI 的话运行: ./start.sh"
echo "======================================================================"
