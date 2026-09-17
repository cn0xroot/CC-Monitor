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

// macOS 没有 /proc，进程的 cwd 只能问 lsof。cwd 拿不到的后果不只是"目录列显示空"：
// /api/status 是靠"活着的 claude 进程的 cwd 集合"来判断某个审计会话背后的进程还在不在的
// （server.js 里的 liveCwds/hasLiveProcess），全是 null 的话每个会话都会被判成 dead，
// 生命体征指示器于是一律画成灰色直线——刚刚还在干活的会话也一样。
//
// 一次把所有 claude 进程的 pid 都传给 lsof（-p 接逗号分隔的列表），避免每个进程
// spawn 一次；-Fpn 让它输出机器可读的 "p<pid>\nfcwd\nn<路径>" 三行一组，不用去解析
// 给人看的对齐表格。跟 Linux 读 /proc 一样受权限限制：别的用户跑的 claude 查不到，
// 如实返回 null。lsof 没装/超时/进程刚退出都只是拿不到值，不当错误处理。
function lsofCwds(pids) {
  return new Promise((resolve) => {
    const out = new Map();
    if (os.platform() !== "darwin" || pids.length === 0) return resolve(out);
    const args = ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"];
    execFile("lsof", args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // 有 pid 查不到时 lsof 会以非 0 退出，但查得到的那部分照样打在 stdout 上，
      // 所以 err 不为空也要继续解析。
      resolve(parseLsofCwds(stdout));
    });
  });
}

// 解析 `lsof -Fpn` 的输出：每组是 "p<pid>" / "fcwd" / "n<路径>" 三行。查不到 cwd 的
// pid 只会有 p 行没有 n 行，直接跳过（不给它编一个路径）。
function parseLsofCwds(stdout) {
  const out = new Map();
  let pid = null;
  for (const line of String(stdout || "").split("\n")) {
    if (line[0] === "p") pid = parseInt(line.slice(1), 10) || null;
    else if (line[0] === "n" && pid !== null) {
      out.set(pid, line.slice(1));
      pid = null;
    }
  }
  return out;
}

// 拿这个 pid 的当前工作目录——Linux 读 /proc（只有跟当前 Web UI 同一个用户的进程才读得到，
// 读别的用户的会直接 EACCES），macOS 从上面那份 lsof 结果里取。两边都拿不到就返回 null，
// 前端如实显示"未知"，不能编一个假的出来。
function tryReadCwd(pid, darwinCwds) {
  if (os.platform() === "linux") {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch (e) {
      return null;
    }
  }
  // 非 darwin 平台上 lsofCwds() 返回的是空 Map（压根没调用 lsof），结果同样是 null
  return darwinCwds.get(pid) || null;
}

async function scanClaudeProcesses() {
  const lines = await psSnapshot();
  // 先把 claude 进程挑出来，再统一查 cwd——macOS 上这样只用跑一次 lsof
  const matched = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, uidStr, user, etime, rssStr, args] = m;
    if (!isClaudeProcess(args)) continue;
    matched.push({ pid: parseInt(pidStr, 10), uidStr, user, etime, rssStr, args });
  }
  const darwinCwds = await lsofCwds(matched.map((p) => p.pid));
  const procs = [];
  for (const { pid, uidStr, user, etime, rssStr, args } of matched) {
    const uptimeSec = parseEtime(etime);
    procs.push({
      pid,
      uid: parseInt(uidStr, 10),
      user,
      cwd: tryReadCwd(pid, darwinCwds),
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

module.exports = { scanClaudeProcesses, summarize, parseLsofCwds };
