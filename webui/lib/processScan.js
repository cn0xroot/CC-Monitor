"use strict";
// 检测机器上所有正在跑的 claude 进程分别是什么操作系统用户身份——这是那次
// "终端软件的弹窗无法检测识别"排查出来的教训：Web UI 和你平时跑 claude 的终端如果
// 不是同一个操作系统用户，两边各写各的 ~/.cc-monitor/ 数据库，互相看不到彼此，
// 而且完全没有提示，得靠手动翻 /proc/<pid>/environ 才查得出来。这个模块只做检测/
// 呈现，不做跨用户数据合并——合并需要读其它用户的 home 目录，权限和隐私上都更复杂，
// 先把"看不见的问题变得看得见"。
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");

// `-A`（选中所有进程）和 `args`（完整命令行）是 POSIX ps(1) 标准里都有定义的选项/
// 字段名，GNU ps（Linux）和 BSD ps（macOS）两边都认——避免用 GNU 专有的 `-e` 或者
// BSD 专有的写法，只为了一条命令能跨平台跑。每个字段后面的 `=` 是让 ps 不要打印表头，
// 这样解析的时候不用先跳过第一行。
// etime（进程已运行多久）和 rss（常驻内存 KB）同样是 POSIX ps(1) 里定义的字段，
// GNU 和 BSD 两边都支持——不用 GNU 专有的 etimes（秒数），是为了 macOS 上也能跑，
// 代价是 etime 的格式要自己解析（见 parseEtime）。args 必须留在最后一个，因为它
// 自带空格、只能靠"剩下的全是它"来切。
function psSnapshot() {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,uid=,user=,etime=,rss=,args="], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.split("\n"));
    });
  });
}

// etime 的格式是 [[DD-]HH:]MM:SS，转成秒。认不出来的返回 null，前端如实显示 "-"，
// 不猜一个数出来。
function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec((s || "").trim());
  if (!m) return null;
  const [, d, h, mi, sec] = m;
  return (parseInt(d || "0", 10) * 86400) + (parseInt(h || "0", 10) * 3600) + (parseInt(mi, 10) * 60) + parseInt(sec, 10);
}

// 只认可执行文件 basename 精确等于 "claude" 的——不用简单的子串匹配，否则
// "cc-monitor-webui" 这类名字里恰好带 "claude" 关键字的其它进程会被误算进来。
function isClaudeProcess(args) {
  const exe = (args || "").trim().split(/\s+/)[0] || "";
  const base = exe.split("/").pop();
  return base === "claude";
}

// 拿这个 pid 的当前工作目录——只有 Linux 有 /proc，且只有跟当前 Web UI 同一个用户的
// 进程才读得到（读别的用户的 /proc/<pid>/cwd 会直接 EACCES），macOS 或者权限不够
// 就返回 null，前端要如实显示"未知"，不能编一个假的出来。
function tryReadCwd(pid) {
  if (os.platform() !== "linux") return null;
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch (e) {
    return null;
  }
}

async function scanClaudeProcesses() {
  const lines = await psSnapshot();
  const procs = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, uidStr, user, etime, rssStr, args] = m;
    if (!isClaudeProcess(args)) continue;
    const pid = parseInt(pidStr, 10);
    const uptimeSec = parseEtime(etime);
    procs.push({
      pid,
      uid: parseInt(uidStr, 10),
      user,
      cwd: tryReadCwd(pid),
      args,
      uptimeSec,
      // 进程启动的绝对时刻（由"现在 - 已运行秒数"反推），前端鼠标悬停时显示
      startedAt: uptimeSec === null ? null : new Date(Date.now() - uptimeSec * 1000).toISOString(),
      rssKb: parseInt(rssStr, 10),
    });
  }
  return procs;
}

function summarize(procs, currentUser) {
  const byUser = {};
  for (const p of procs) {
    if (!byUser[p.user]) byUser[p.user] = 0;
    byUser[p.user] += 1;
  }
  const otherUsers = Object.keys(byUser).filter((u) => u !== currentUser);
  return {
    currentUser,
    total: procs.length,
    byUser,
    mismatchedUsers: otherUsers,
    processes: procs,
  };
}

module.exports = { scanClaudeProcesses, summarize };
