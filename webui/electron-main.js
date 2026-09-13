"use strict";
// 桌面版入口——Electron 自带 Node.js，现有的 server.js（Express + ws + node-pty +
// better-sqlite3）不用改一行代码，直接 require 进来就在同一个进程里跑起来了。
// 跟"用浏览器打开网页版"的区别只是：不用自己手动 npm start + 开浏览器，双击图标
// 就有一个独立窗口，且默认只服务给这个窗口自己（不依赖浏览器/系统代理设置）。
//
// root 用户运行时需要 --no-sandbox（Chromium 的沙箱机制靠 Linux 用户命名空间隔离，
// root 本来就有完全权限，隔离对它没有意义，不加这个参数直接 FATAL 退出，见
// https://crbug.com/638180）。这个检查发生在 Electron 原生启动阶段，比这个文件里
// 任何一行 JS 都早执行——已经实测验证过，就算在这里最开头用 Node 自己重新拉起带
// 这个参数的自己也来不及，因为这段 JS 本身根本没有机会在崩溃前执行到。所以这个开关
// 必须在 spawn electron 这个二进制之前，从外部就带进真正的进程 argv 里：`npm run
// electron` 走 scripts/electron-start.js 这个 launcher；打包出来的 AppImage/二进制
// 走发布时一起带的 wrapper 脚本。这个文件本身不需要、也做不到处理这件事。
const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");

// 桌面版场景下没必要监听一个"给别的设备连"的端口——固定绑本机，端口选一个不常用的，
// 减少跟用户机器上其它服务撞端口的概率（网页版默认的 9999 保持不变，互不影响，
// 两种用法可以同时开着）。
process.env.CC_MONITOR_WEBUI_HOST = process.env.CC_MONITOR_WEBUI_HOST || "127.0.0.1";
process.env.CC_MONITOR_WEBUI_PORT = process.env.CC_MONITOR_WEBUI_PORT || "9998";

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "CC-Monitor",
    webPreferences: {
      // 页面本身不需要 Node 能力（它就是套壳跑我们自己的 Web UI，用的是普通浏览器 API），
      // 关掉 nodeIntegration/开 contextIsolation 是 Electron 官方安全基线，没有理由破例。
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.loadURL(`http://${process.env.CC_MONITOR_WEBUI_HOST}:${process.env.CC_MONITOR_WEBUI_PORT}/`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // require 这一下就会真的把 server.js 底部的 server.listen(...) 跑起来——
  // 这个模块本来就是给"跑起来直接监听"设计的，桌面版不用另外包一层"等它 ready"的逻辑，
  // Node 的 require 是同步的，跑到这行下面时端口已经在监听了。
  require("./server.js");
  Menu.setApplicationMenu(null); // 套壳应用不需要一整条菜单栏，页面自己的导航够用
  createWindow();

  app.on("activate", () => {
    // macOS 惯例：dock 图标被点、且没有窗口时重新开一个（不重新 require server.js，
    // 那个只应该跑一次）。
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Windows/Linux 惯例：关掉最后一个窗口就退出整个 app；macOS 惯例是留在 dock 里。
  if (process.platform !== "darwin") app.quit();
});
