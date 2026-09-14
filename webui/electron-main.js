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
const { app, BrowserWindow, Menu, Notification, shell } = require("electron");
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

// ---- AI 审批台的桌面提醒（主进程侧）----
// 网页版靠浏览器的 Notification API 弹系统通知；套在 Electron 里时那条路在 macOS 上是
// 坏的：渲染进程里 Notification.permission 永远是 "granted"（Electron 不实现真正的授权
// 流程），new Notification() 也不报错，但底层走的是 UNUserNotificationCenter，未正式签名
// 的 app（`npm run electron` 跑的 node_modules 里那个 Electron.app 只有 ad-hoc 签名）会被
// 系统直接拒绝——实测主进程 Notification 触发 failed 事件 "UNErrorDomain error 1"
// （= UNErrorCodeNotificationsNotAllowed），渲染进程那边则是静默失败，什么都不弹。
// 所以桌面版改成主进程自己轮询待批准列表，能弹系统通知就弹，弹不了也一定有 Dock 跳动
// + 角标 + 窗口置前这几样不依赖签名的提醒；页面里那条 Notification API 的路在 Electron
// 里关掉（app.js 按 UA 判断），免得两边各弹一次。
const approvals = require("./lib/approvals");
const APPROVAL_POLL_MS = 2000;
const notifiedApprovalIds = new Set();
let nativeNotificationBroken = false;

function approvalTitle(kind) {
  if (kind === "notify") return "CC-Monitor：有个问题在等你回答";
  if (kind === "permission") return "CC-Monitor：Claude 请求权限";
  return "CC-Monitor：有操作待批准";
}

function approvalBody(r) {
  let summary = r.matched_value || "";
  if (r.kind === "notify") {
    try {
      summary = JSON.parse(summary).map((q) => q.question || "").join(" / ") || summary;
    } catch (e) {
      // 不是预期的 JSON 就原样显示
    }
  }
  const folder = (r.cwd || "").split("/").filter(Boolean).pop() || r.cwd || "";
  return `${r.tool_name} · ${folder}\n${summary}`.slice(0, 200);
}

function showApprovalsTab() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents
    .executeJavaScript(`document.querySelector('.tab-btn[data-tab="approvals"]')?.click()`)
    .catch(() => {});
}

function announceApproval(r) {
  // 这几样不需要任何系统授权：系统提示音 + Dock 图标跳动（macOS）/任务栏闪烁（Windows、
  // Linux）+ 角标（pollApprovals 里维护）。
  shell.beep();
  if (app.dock) app.dock.bounce("critical");
  if (mainWindow) mainWindow.flashFrame(true);
  if (nativeNotificationBroken || !Notification.isSupported()) return;
  const n = new Notification({ title: approvalTitle(r.kind), body: approvalBody(r) });
  n.on("click", showApprovalsTab);
  n.on("failed", (_event, error) => {
    // 一次失败之后就别再每条都试了，失败原因基本都是"这个 app 没有通知权限"这类不会
    // 自己好转的问题；Dock 跳动 + 角标照常。
    nativeNotificationBroken = true;
    console.warn(
      `[CC-Monitor] 系统通知弹不出来（${error}）。未正式签名的 Electron（npm run electron）在 macOS 上会被系统拒绝；` +
        "Dock 图标跳动和角标不受影响。"
    );
  });
  n.show();
}

function pollApprovals() {
  let rows;
  try {
    rows = approvals.listPending();
  } catch (e) {
    return;
  }
  if (app.dock) app.dock.setBadge(rows.length ? String(rows.length) : "");
  const stillPending = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    if (notifiedApprovalIds.has(r.id)) continue;
    notifiedApprovalIds.add(r.id);
    announceApproval(r);
  }
  for (const id of notifiedApprovalIds) {
    if (!stillPending.has(id)) notifiedApprovalIds.delete(id);
  }
}

app.whenReady().then(() => {
  // require 这一下就会真的把 server.js 底部的 server.listen(...) 跑起来——
  // 这个模块本来就是给"跑起来直接监听"设计的，桌面版不用另外包一层"等它 ready"的逻辑，
  // Node 的 require 是同步的，跑到这行下面时端口已经在监听了。
  require("./server.js");
  Menu.setApplicationMenu(null); // 套壳应用不需要一整条菜单栏，页面自己的导航够用
  createWindow();
  setInterval(pollApprovals, APPROVAL_POLL_MS);

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
