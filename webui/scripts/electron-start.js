"use strict";
// `npm run electron` 在 root 下会被 Chromium 直接 FATAL 拒绝启动（sandbox 依赖 Linux
// 用户命名空间降权，对已经是 root 的进程没有意义，详见 electron-main.js 顶部注释）。
// 这个检查发生在 Electron 原生 main 的启动阶段，比 electron-main.js 里任何 JS 代码
// 都早执行，运行时用 app.commandLine.appendSwitch 加不进去——必须在真正 spawn 出
// electron 二进制时，就把 --no-sandbox 放进它的 argv 里。这里用一个小 launcher 按
// 身份决定要不要加这个参数，避免直接在 package.json 里写死 --no-sandbox（那样非 root
// 用户平时运行也会连带失去沙箱保护）。
const { spawnSync } = require("child_process");
const path = require("path");

const electronPath = require("electron");
const entry = path.join(__dirname, "..", "electron-main.js");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
// --no-sandbox 只关掉了渲染进程的沙箱，GPU 进程有自己独立的一层沙箱，root 下同样
// 会因为拿不到降权后的用户命名空间而起不来（"GPU process isn't usable. Goodbye."），
// 必须一并关掉。
const args = isRoot ? ["--no-sandbox", "--disable-gpu-sandbox", entry] : [entry];

const result = spawnSync(electronPath, args, { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
