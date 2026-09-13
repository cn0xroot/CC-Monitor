#!/usr/bin/env bash
# 打包出来的 AppImage 是单个可执行文件，双击/直接运行时不经过任何 npm 脚本，所以
# electron-main.js 里那套「node launcher 按身份加 --no-sandbox」的办法在这里用不上——
# Chromium 的 root-sandbox 检查发生在原生启动阶段，比 AppImage 里任何 JS 代码都早，
# 唯一能生效的办法是在真正启动这个二进制之前，从外部把 --no-sandbox（还有
# --disable-gpu-sandbox，GPU 进程有独立的一层沙箱，同样会因为 root 起不来）放进它的
# 启动参数里。这个脚本只做这一件事：是 root 才加这两个参数，其它身份直接原样启动，
# 沙箱保护不受影响。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPIMAGE="$(ls "$DIR"/CC-Monitor-*.AppImage 2>/dev/null | head -n1)"

if [ -z "$APPIMAGE" ]; then
  echo "找不到同目录下的 CC-Monitor-*.AppImage，请确认这个脚本和 AppImage 放在一起。" >&2
  exit 1
fi

if [ "$(id -u)" = "0" ]; then
  exec "$APPIMAGE" --no-sandbox --disable-gpu-sandbox "$@"
else
  exec "$APPIMAGE" "$@"
fi
