"use strict";
// node-pty 在 macOS/Linux 上不是直接 fork+exec，而是先起一个自带的小程序
// `prebuilds/<platform>-<arch>/spawn-helper` 去 setsid/打开 pty，再由它 exec 真正的 shell。
// 这个文件是 npm 从 tarball 里解出来的，某些 npm 版本/文件系统组合下会丢掉可执行位
// （实测 macOS + npm 11 装出来是 -rw-r--r--），于是 pty.spawn() 直接抛
// "posix_spawnp failed."——Web UI 里"新建会话"就是一句 500，什么信息都没有。
// 这里把所有 spawn-helper 补上 0755。幂等、跨平台（Windows 没有这个文件，直接跳过），
// 既作为 npm postinstall 跑，也在 server.js 启动时再跑一次（打包成 Electron 后没有
// postinstall 这一步，而 asar.unpacked 解出来的文件同样可能没权限）。
const fs = require("fs");
const path = require("path");

function fixNodePtyPerms(nodeModulesDir) {
  const prebuilds = path.join(nodeModulesDir || path.join(__dirname, "..", "node_modules"), "node-pty", "prebuilds");
  let fixed = [];
  let entries;
  try {
    entries = fs.readdirSync(prebuilds);
  } catch (e) {
    return fixed; // 没装 node-pty / Windows 平台，没什么可修的
  }
  for (const dir of entries) {
    const helper = path.join(prebuilds, dir, "spawn-helper");
    try {
      const st = fs.statSync(helper);
      if ((st.mode & 0o111) !== 0o111) {
        fs.chmodSync(helper, st.mode | 0o755);
        fixed.push(helper);
      }
    } catch (e) {
      // 这个平台目录里没有 spawn-helper（比如 win32-*），跳过
    }
  }
  return fixed;
}

if (require.main === module) {
  const fixed = fixNodePtyPerms();
  if (fixed.length) console.log(`[CC-Monitor] 已给 node-pty spawn-helper 补上可执行权限: ${fixed.join(", ")}`);
}

module.exports = { fixNodePtyPerms };
