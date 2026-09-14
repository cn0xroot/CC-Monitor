"use strict";
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

function dbPath() {
  const home = process.env.CC_MONITOR_HOME || path.join(os.homedir(), ".cc-monitor");
  return path.join(home, "events.db");
}

// 按 ; & | 换行 把一条 Bash 命令切成"子命令"分别看开头——这是本文件好几个分类器
// 共用的手法（不对整条命令文本做子串匹配，避免 echo 出来的字符串被误判成真的
// 执行了什么）。但天真地对整条命令文本做 cmd.split(/[;&|\n]+/) 有个漏洞：引号内的
// 多行字符串参数、heredoc（<<'EOF' ... EOF）的正文里，换行是内容的一部分，不是
// shell 语法意义上的命令分隔符——如果不管这些，会被当成一堆"独立子命令"分别去看
// 开头，实测线上数据抓到两个真实案例：
//   1. `python3 -c "\nimport json, sys\n..."` —— 双引号参数里的 "import json, sys"
//      单独成一行，被当成了 ImageMagick 截图命令 import 的调用；
//   2. `git commit -m "$(cat <<'EOF' ... EOF)"` —— heredoc 正文里 word-wrap 过的一行
//      刚好以 "spectacle" 开头（描述 KDE 截图工具名字的说明文字），被当成了真的在
//      调用 spectacle 截图。
// splitShellSegments() 用一个简化版的 shell 分词器解决这个问题：跟踪当前在不在
// 单/双引号、在不在 heredoc 正文里，只有真正在"顶层"（不在引号/heredoc 内部）的
// ; & | 换行才当分隔符。不追求 100% 还原 bash 语法（比如反引号/嵌套 $() 里的换行
// 没特殊处理），但已经覆盖了实际观测到的两种误判来源。
function splitShellSegments(cmd) {
  const segments = [];
  let cur = "";
  let i = 0;
  let quote = null; // "'" | '"' | null
  let heredocEnd = null; // 结束定界符，或者 null（不在 heredoc 正文里）
  const n = cmd.length;
  while (i < n) {
    if (heredocEnd !== null) {
      const lineEnd = cmd.indexOf("\n", i);
      const line = lineEnd === -1 ? cmd.slice(i) : cmd.slice(i, lineEnd);
      cur += line;
      if (line.trim() === heredocEnd) heredocEnd = null;
      if (lineEnd === -1) {
        i = n;
      } else {
        cur += "\n";
        i = lineEnd + 1;
      }
      continue;
    }
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "<" && cmd[i + 1] === "<") {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(cmd.slice(i));
      if (m) {
        cur += m[0];
        i += m[0].length;
        const nl = cmd.indexOf("\n", i);
        if (nl === -1) {
          i = n;
        } else {
          cur += cmd.slice(i, nl + 1);
          i = nl + 1;
          heredocEnd = m[2];
        }
        continue;
      }
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
      segments.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur) segments.push(cur);
  return segments;
}

// 判断一条 Bash 命令里是不是真的在删文件——按 splitShellSegments() 切成子命令分别
// 看开头，而不是对整条命令文本做子串匹配。之前用 SQL LIKE '%rm %' 之类的写法会把
// "confirm "/"warm "/"term " 这些词尾带 "rm " 的普通输出也算成删除，
// 或者把 echo 出来的字符串（比如 echo "rm -rf 很危险"）也算成真的删除，误报非常多。
function commandDeletesFiles(cmd) {
  if (!cmd) return false;
  // find -exec rm ... \; / cmd | xargs rm 这类不在子命令开头，单独兜底判断一下。
  if (/(?:^|\s)(?:-exec\s+|xargs\s+(?:-\S+\s+)*)(?:rm|shred|unlink)\b/.test(cmd)) return true;
  const segments = splitShellSegments(cmd);
  for (const raw of segments) {
    const seg = raw.trim().replace(/^sudo\s+/, "");
    if (/^(rm|rmdir|unlink|shred|trash-put|trash)\b/.test(seg)) return true;
    if (/^git\s+rm\b/.test(seg)) return true;
    if (/^find\b/.test(seg) && /(?:^|\s)-delete(?:\s|$)/.test(seg)) return true;
  }
  return false;
}

function isDeleteEvent(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return commandDeletesFiles(detail.command || "") ? 1 : 0;
  } catch (e) {
    return 0;
  }
}

// GitHub 相关操作分类——跟 commandDeletesFiles 同一个思路：按 ; & | 换行 切成子命令
// 分别看开头，而不是对整条命令文本做子串匹配（避免把 echo "git push 很危险" 这种
// 字符串输出也算成真的执行了 git push）。一条 Bash 命令里可能好几个子命令都命中
// （比如 `git add . && git commit -m x && git push`），按"最具体"优先返回一个分类，
// 不是每个子命令都单独计数——跟 commandDeletesFiles 返回单个布尔值是同一个道理。
const GITHUB_OP_ORDER = ["push", "clone", "commit", "pullFetch", "ghCli", "otherGit"];
function classifyGithubOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^git\s+push\b/.test(seg)) found.add("push");
    else if (/^git\s+clone\b/.test(seg)) found.add("clone");
    else if (/^git\s+commit\b/.test(seg)) found.add("commit");
    else if (/^git\s+(pull|fetch)\b/.test(seg)) found.add("pullFetch");
    else if (/^gh\s+\S/.test(seg)) found.add("ghCli");
    else if (/^git\s+\S/.test(seg)) found.add("otherGit");
  }
  for (const kind of GITHUB_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function githubOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyGithubOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// SSH 相关操作分类——跟 classifyGithubOp 完全一样的思路：按 ; & | 换行拆成子命令，
// 只看子命令开头（`\s|$` 而不是 `\b`，是为了不把 ssh-keygen/ssh-copy-id/ssh-add/
// ssh-agent 这些名字里带连字符的独立命令误判成 "ssh" 本身——单纯用 \b 的话
// "ssh-keygen" 里 "ssh" 后面紧跟的 "-" 也算一次词边界，会被 /^ssh\b/ 误命中）。
const SSH_OP_ORDER = ["ssh", "scp", "sftp", "keyManagement", "other"];
function classifySshOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^ssh(\s|$)/.test(seg)) found.add("ssh");
    else if (/^scp(\s|$)/.test(seg)) found.add("scp");
    else if (/^sftp(\s|$)/.test(seg)) found.add("sftp");
    else if (/^(ssh-keygen|ssh-copy-id|ssh-add|ssh-agent)(\s|$)/.test(seg)) found.add("keyManagement");
    else if (/^(autossh|sshpass|ssh-askpass)(\s|$)/.test(seg)) found.add("other");
  }
  for (const kind of SSH_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function sshOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifySshOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// 下载行为分类——跟 classifyGithubOp/classifySshOp 一样按子命令开头识别，注意不要
// 跟其它已经单独统计过的分类重叠（git clone 算 GitHub 操作、pip/npm/系统包管理器
// 安装算软件安装统计，这里全部不再重复计数，只看专门的下载类工具）。
// curl 单独处理：只有带了真正落盘的参数（-o/-O/--output/--remote-name）才算"下载"，
// 裸 curl（比如 curl https://api.example.com/status）绝大多数是在调 API 看返回内容，
// 不是在下载文件，全算成下载会把普通的接口调用也算进来，噪音太大。
const DOWNLOAD_OP_ORDER = ["wget", "curl", "aria2", "other"];
const CURL_OUTPUT_FLAG_RE = /(^|\s)(-O\b|--remote-name\b|-o\s|--output(\s|=))/;
function classifyDownloadOp(cmd) {
  if (!cmd) return null;
  const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
  const found = new Set();
  for (const seg of segments) {
    if (/^wget2?(\s|$)/.test(seg)) found.add("wget");
    else if (/^curl(\s|$)/.test(seg) && CURL_OUTPUT_FLAG_RE.test(seg)) found.add("curl");
    else if (/^aria2c?(\s|$)/.test(seg)) found.add("aria2");
    else if (/^(axel|lftp|ftp|http|https)(\s|$)/.test(seg)) found.add("other");
  }
  for (const kind of DOWNLOAD_OP_ORDER) {
    if (found.has(kind)) return kind;
  }
  return null;
}

function downloadOpType(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return classifyDownloadOp(detail.command || "");
  } catch (e) {
    return null;
  }
}

// 从命令文本里抠目标主机名——三种写法都要认，全部要求有明确、低误判风险的语法标记，
// 不认"看起来像域名的裸单词"：
//   1. URL 形式：协议://[user@]host[:port]/…（wget/curl/aria2/axel/lftp/http(s)）
//   2. user@host（ssh/sftp 的典型写法，@ 前缀是强信号，不会跟本地文件名搞混）
//   3. host:path（scp/rsync 的远程规格，不带 user@ 也行，但一定要紧跟冒号）
// 特意不认"裸主机名、没有 @ 也没有冒号"这种写法（比如 `ssh myserver`、或者
// `scp file.txt user@host:/path` 里的本地源文件 file.txt）——第一版曾经用一个更宽的
// 正则把 `-o out.tar.gz` 的输出文件名、scp 的本地源文件名都当成了"主机名"，因为
// 这些文件名本身也是带点的字符串、后面跟着空白，形状上跟目标主机没法用纯正则区分。
// 宁可漏掉内网短名这种真正的边缘情况，也不要把命令里随便一个带点的单词当成主机名。
const URL_HOST_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^\s@/]+@)?([^\s/:?#'"]+)/g;
const AT_HOST_RE = /@((?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}|(?:\d{1,3}\.){3}\d{1,3})/g;
const COLON_HOST_RE = /(?:^|[\s])((?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}|(?:\d{1,3}\.){3}\d{1,3}):(?=[\w~./]|$)/g;

function extractCommandHosts(text) {
  if (!text) return [];
  const hosts = new Set();
  let m;
  URL_HOST_RE.lastIndex = 0;
  while ((m = URL_HOST_RE.exec(text))) hosts.add(m[1].toLowerCase());
  AT_HOST_RE.lastIndex = 0;
  while ((m = AT_HOST_RE.exec(text))) hosts.add(m[1].toLowerCase());
  COLON_HOST_RE.lastIndex = 0;
  while ((m = COLON_HOST_RE.exec(text))) hosts.add(m[1].toLowerCase());
  return Array.from(hosts);
}

// 哪些子命令算"发起了网络请求"——比下载行为统计（DOWNLOAD_OP_ORDER）宽一些：那边
// 特意把不带 -o/-O 的裸 curl 排除在外（避免把纯 API 调用算成"下载"），但对 AI 轨迹
// 来说，裸 curl 调 API 本身也是一次真实的网络请求，理应体现在轨迹里，不该套用下载
// 统计那条更窄的口径。git 只算 clone/pull/fetch/push 这几个会真的发起网络连接的
// 子命令，commit 是纯本地操作不算。ssh 系列里 keyManagement（ssh-keygen 等）是本地
// 操作，同样不算。
function isNetworkTouchingSegment(seg) {
  return (
    /^(wget2?|curl|aria2c?|axel|lftp|ftp|https?)(\s|$)/.test(seg) ||
    /^git\s+(clone|pull|fetch|push)\b/.test(seg) ||
    /^(ssh|scp|sftp|autossh|sshpass)(\s|$)/.test(seg)
  );
}

// 由 Claude 通过 Bash 执行、涉及网络请求的命令——跟系统层探针（os_net，实测到的
// 真实 connect()）是两种不同性质的证据：这里只是"命令文本上看起来会联网"，不代表
// 真的连通了（可能失败/超时/被 policy 拦截），也没有字节数可言。用户明确要求：这类
// 命令没被探针捕捉到时，也要能在"AI 轨迹"里体现出来（很多人根本没有手动启动过
// system 层探针，之前完全没有这块可见性）。只看 Claude 自己触发的 hook_pre 事件，
// 用户在别的终端里手打的命令不会经过 Claude Code 的 hooks，天然不会出现在这里。
function commandNetworkHosts(limit = 2000) {
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT id, ts, session_id, cwd, detail FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Bash'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
    const out = [];
    for (const row of rows) {
      let detail;
      try {
        detail = row.detail ? JSON.parse(row.detail) : {};
      } catch (e) {
        continue;
      }
      const cmd = detail.command || "";
      const segments = splitShellSegments(cmd).map((raw) => raw.trim().replace(/^sudo\s+/, ""));
      const hostsInCmd = new Set();
      for (const seg of segments) {
        if (!isNetworkTouchingSegment(seg)) continue;
        for (const host of extractCommandHosts(seg)) hostsInCmd.add(host);
      }
      for (const host of hostsInCmd) {
        out.push({ id: row.id, ts: row.ts, sessionId: row.session_id, cwd: row.cwd, command: cmd, host });
      }
    }
    return out;
  }, []);
}

// 截屏审计——Claude Code 没有内置"截图"工具，实际观测到的截屏行为分三种路子，
// 判断方式各自独立、按"最可能"的信号来源分开看：
//   1. Bash 命令调用了截图类 CLI 工具——跟 commandDeletesFiles() 一个思路，按
//      splitShellSegments() 拆成子命令分别看开头，不对整条命令文本做子串匹配
//      （避免 "echo 截图完成" 这种输出内容被误判）。原来列表里还有 ImageMagick 的
//      import 命令，线上实测发现这是个坏主意——"import" 是 Python 极常用的关键字，
//      即使用了 splitShellSegments() 正确跳过引号/heredoc 内部的换行，只要用户
//      自己的 shell 脚本里有一行真的以裸 "import ..." 开头（比如反引号/未加引号的
//      command substitution 里），还是会被误判成在调用截图工具。ImageMagick 的
//      import 命令本身在现代 Linux 桌面上也已经边缘化（grim/flameshot/spectacle/
//      gnome-screenshot 这些更常见），删掉它换来的误判下降比丢的召回率划算得多。
//      Wayland 下常见的走法是通过 xdg-desktop-portal 发 D-Bus 请求（gdbus/dbus-send
//      调 org.freedesktop.portal.Screenshot 接口），命令行工具反而用不了，单独判断。
//   2. Read 工具打开的文件本身就是图片——不严格等于"截屏"（也可能是用户自己的照片/
//      设计稿），但从"Claude 看到了屏幕/图像内容"这个角度审计，用户明确要求把这种
//      情况也算进来，接受比纯粹截图判断更宽的召回率。
//   3. MCP/"computer use" 类工具的截图动作——工具名里带 "screenshot" 字样（常见于
//      Playwright/Puppeteer 这类浏览器自动化 MCP server 暴露出来的工具名，比如
//      mcp__playwright__browser_take_screenshot），或者 Anthropic Computer Use 的
//      "computer" 工具、action 字段等于 "screenshot"。
const SCREENSHOT_CLI_RE = /^(scrot|gnome-screenshot|spectacle|flameshot|maim|grim|xwd|deepin-screenshot|xfce4-screenshooter|screencapture)\b/;
const SCREENSHOT_PORTAL_RE = /^(gdbus|dbus-send)\b/;
const SCREENSHOT_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

function commandTakesScreenshot(cmd) {
  if (!cmd) return false;
  const segments = splitShellSegments(cmd);
  for (const raw of segments) {
    const seg = raw.trim().replace(/^sudo\s+/, "");
    if (SCREENSHOT_CLI_RE.test(seg)) return true;
    if (SCREENSHOT_PORTAL_RE.test(seg) && /screenshot/i.test(seg)) return true;
  }
  return false;
}

function isScreenCaptureEvent(toolName, detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    if (toolName === "Bash") {
      return commandTakesScreenshot(detail.command || "") ? 1 : 0;
    }
    if (toolName === "Read") {
      const filePath = detail.file_path || detail.path || "";
      return SCREENSHOT_IMAGE_EXT_RE.test(filePath) ? 1 : 0;
    }
    if (toolName === "computer" && detail.action === "screenshot") return 1;
    if (toolName && toolName !== "Bash" && toolName !== "Read" && /screenshot/i.test(toolName)) return 1;
    return 0;
  } catch (e) {
    return 0;
  }
}

function withDb(fn, fallback) {
  let db;
  try {
    db = new Database(dbPath(), { readonly: true, fileMustExist: true });
    db.function("cc_is_delete", isDeleteEvent);
    db.function("cc_github_op", githubOpType);
    db.function("cc_is_screenshot", isScreenCaptureEvent);
    db.function("cc_ssh_op", sshOpType);
    db.function("cc_download_op", downloadOpType);
    return fn(db);
  } catch (e) {
    return fallback;
  } finally {
    if (db) db.close();
  }
}

// `transcript_path` 列是 cc_monitor/storage.py 那边升级后才懒加载 ALTER TABLE 加上的
// （见 storage.py 的 `_connect()`），旧数据库在第一次跑新版 hook 之前还没有这一列。
// Node 这边是只读连接，不能自己补列，所以查询前先探测一下，没有就优雅降级。
function hasTranscriptColumn(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(events)`).all();
    return cols.some((c) => c.name === "transcript_path");
  } catch (e) {
    return false;
  }
}

function listSessions(limit = 200) {
  return withDb((db) => {
    const withTranscript = hasTranscriptColumn(db);
    return db
      .prepare(
        `SELECT session_id, cwd, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS event_count,
                SUM(CASE WHEN decision = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
                SUM(CASE WHEN matched_rule = 'hook_bypass_suspected' THEN 1 ELSE 0 END) AS bypass_count
                ${withTranscript ? ", MAX(transcript_path) AS transcript_path" : ""}
         FROM events
         WHERE session_id IS NOT NULL AND session_id != ''
         GROUP BY session_id
         ORDER BY last_ts DESC
         LIMIT ?`
      )
      .all(limit);
  }, []);
}

function getTranscriptPath(sessionId) {
  return withDb((db) => {
    if (!hasTranscriptColumn(db)) return null;
    const row = db
      .prepare(
        `SELECT transcript_path FROM events
         WHERE session_id = ? AND transcript_path IS NOT NULL AND transcript_path != ''
         ORDER BY id DESC LIMIT 1`
      )
      .get(sessionId);
    return row ? row.transcript_path : null;
  }, null);
}

function queryEvents({ sessionId, sinceId = 0, limit = 300 } = {}) {
  return withDb((db) => {
    let sql = `SELECT id, ts, session_id, source, tool_name, cwd, risk, matched_rule, decision, detail
               FROM events WHERE id > ?`;
    const params = [sinceId];
    if (sessionId) {
      sql += ` AND session_id = ?`;
      params.push(sessionId);
    }
    sql += ` ORDER BY id ASC LIMIT ?`;
    params.push(limit);
    return db.prepare(sql).all(...params);
  }, []);
}

function stats() {
  return withDb((db) => {
    const byRisk = db.prepare(`SELECT risk, COUNT(*) AS n FROM events GROUP BY risk`).all();
    const byDecision = db.prepare(`SELECT decision, COUNT(*) AS n FROM events GROUP BY decision`).all();
    const bySource = db.prepare(`SELECT source, COUNT(*) AS n FROM events GROUP BY source`).all();
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n;
    const sessionCount = db
      .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE session_id IS NOT NULL AND session_id != ''`)
      .get().n;
    const blockedTotal = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE decision = 'blocked'`).get().n;
    const bypassTotal = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE matched_rule = 'hook_bypass_suspected'`)
      .get().n;
    return { total, sessionCount, blockedTotal, bypassTotal, byRisk, byDecision, bySource };
  }, { total: 0, sessionCount: 0, blockedTotal: 0, bypassTotal: 0, byRisk: [], byDecision: [], bySource: [] });
}

// 文件读/写/编辑/删除次数——删除没有专门的工具（Claude Code 没有内置"删文件"工具），
// 靠解析 Bash 命令文本（只看 detail.command 字段本身，按 ; & | 拆成子命令再看开头是不是
// rm/rmdir/unlink/shred/git rm/find -delete 等）来识别，见上面 commandDeletesFiles()。
// 不是 100% 精确（比如 $() 命令替换里的删除识别不到），但比之前的整串 LIKE 子串匹配准确得多。
const DELETE_CLAUSE = `source = 'hook_pre' AND tool_name = 'Bash' AND cc_is_delete(detail) = 1`;

function fileOpsStats() {
  return withDb((db) => {
    const countTool = (names) => {
      const placeholders = names.map(() => "?").join(",");
      return db
        .prepare(
          `SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name IN (${placeholders})`
        )
        .get(...names).n;
    };
    const reads = countTool(["Read"]);
    const writes = countTool(["Write"]);
    const edits = countTool(["Edit", "MultiEdit", "NotebookEdit"]);
    const deletes = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${DELETE_CLAUSE}`).get().n;
    return { reads, writes, edits, deletes };
  }, { reads: 0, writes: 0, edits: 0, deletes: 0 });
}

const FILE_OP_TOOLS = {
  read: ["Read"],
  write: ["Write"],
  edit: ["Edit", "MultiEdit", "NotebookEdit"],
};

// 首页文件操作卡片（读/写/编辑/删除）的下钻详情：具体是哪些事件。
function fileOpDetails(type, limit = 300) {
  return withDb((db) => {
    if (type === "delete") {
      return db
        .prepare(`SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events WHERE ${DELETE_CLAUSE} ORDER BY id DESC LIMIT ?`)
        .all(limit);
    }
    const tools = FILE_OP_TOOLS[type];
    if (!tools) return [];
    const placeholders = tools.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND tool_name IN (${placeholders})
         ORDER BY id DESC LIMIT ?`
      )
      .all(...tools, limit);
  }, []);
}

// 软件安装统计——不用另外写识别逻辑，直接复用 policy 规则引擎已经判过的 matched_rule
// 分组就行（pip/系统包管理器/npm/其它这几类规则本来就在 default_rules.json 里维护着，
// 识别逻辑只有一份，不会跟 policy 那边判断的标准不一致）。
const INSTALL_RULE_GROUPS = {
  pip: ["sudo_pip_install", "pip_install_venv_context", "pip_install_no_venv"],
  system: ["system_package_install"],
  // 本地/全局两条规则都算进"npm 安装"这一张卡片的总数，点开详情时前端按
  // matchedRule 再拆成"本地安装"/"全局安装"两组分别列出（见 app.js 的
  // install-op-npm 特判），不是简单平铺一份列表。
  npm: ["npm_global_install", "npm_local_install"],
  other: ["package_install_other"],
};

function installStats() {
  return withDb((db) => {
    const countRules = (rules) => {
      const placeholders = rules.map(() => "?").join(",");
      return db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND matched_rule IN (${placeholders})`)
        .get(...rules).n;
    };
    return {
      pip: countRules(INSTALL_RULE_GROUPS.pip),
      system: countRules(INSTALL_RULE_GROUPS.system),
      npm: countRules(INSTALL_RULE_GROUPS.npm),
      other: countRules(INSTALL_RULE_GROUPS.other),
    };
  }, { pip: 0, system: 0, npm: 0, other: 0 });
}

// 首页软件安装统计卡片（pip/系统包/npm/其它）的下钻详情：具体是哪些安装指令。
function installDetails(type, limit = 300) {
  const rules = INSTALL_RULE_GROUPS[type];
  if (!rules) return [];
  return withDb((db) => {
    const placeholders = rules.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${placeholders})
         ORDER BY id DESC LIMIT ?`
      )
      .all(...rules, limit);
  }, []);
}

// GitHub 操作统计（push/clone/commit/pull-fetch/gh CLI/其它 git 操作）——不像
// 软件安装那样能复用 policy 规则的 matched_rule（大部分 git/gh 命令本来就不违反
// 任何规则，压根不会被打上 matched_rule），得直接看命令文本，所以用上面注册的
// cc_github_op() 自定义 SQL 函数分类。
const GITHUB_OP_TYPES = ["push", "clone", "commit", "pullFetch", "ghCli", "otherGit"];
function githubOpsStats() {
  return withDb((db) => {
    const rows = db
      .prepare(`SELECT cc_github_op(detail) AS kind, COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name = 'Bash' GROUP BY kind`)
      .all();
    const counts = { push: 0, clone: 0, commit: 0, pullFetch: 0, ghCli: 0, otherGit: 0 };
    for (const r of rows) {
      if (r.kind && counts[r.kind] !== undefined) counts[r.kind] = r.n;
    }
    return counts;
  }, { push: 0, clone: 0, commit: 0, pullFetch: 0, ghCli: 0, otherGit: 0 });
}

function githubOpsDetails(type, limit = 300) {
  if (!GITHUB_OP_TYPES.includes(type)) return [];
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Bash' AND cc_github_op(detail) = ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(type, limit);
  }, []);
}

// SSH 操作统计（ssh/scp/sftp/密钥管理/其它）——跟 GitHub 操作统计一个思路，大部分
// ssh/scp 命令本来就不违反任何 policy 规则，压根不会被打上 matched_rule，得直接看
// 命令文本，用上面注册的 cc_ssh_op() 自定义 SQL 函数分类。
function sshOpsStats() {
  return withDb((db) => {
    const rows = db
      .prepare(`SELECT cc_ssh_op(detail) AS kind, COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name = 'Bash' GROUP BY kind`)
      .all();
    const counts = { ssh: 0, scp: 0, sftp: 0, keyManagement: 0, other: 0 };
    for (const r of rows) {
      if (r.kind && counts[r.kind] !== undefined) counts[r.kind] = r.n;
    }
    return counts;
  }, { ssh: 0, scp: 0, sftp: 0, keyManagement: 0, other: 0 });
}

function sshOpsDetails(type, limit = 300) {
  if (!SSH_OP_ORDER.includes(type)) return [];
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Bash' AND cc_ssh_op(detail) = ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(type, limit);
  }, []);
}

// 下载行为统计（wget/curl/aria2/其它）——同上一套思路，直接看命令文本分类。
function downloadOpsStats() {
  return withDb((db) => {
    const rows = db
      .prepare(`SELECT cc_download_op(detail) AS kind, COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name = 'Bash' GROUP BY kind`)
      .all();
    const counts = { wget: 0, curl: 0, aria2: 0, other: 0 };
    for (const r of rows) {
      if (r.kind && counts[r.kind] !== undefined) counts[r.kind] = r.n;
    }
    return counts;
  }, { wget: 0, curl: 0, aria2: 0, other: 0 });
}

function downloadOpsDetails(type, limit = 300) {
  if (!DOWNLOAD_OP_ORDER.includes(type)) return [];
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Bash' AND cc_download_op(detail) = ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(type, limit);
  }, []);
}

// 首页"截屏审计"卡片：单一计数，不像软件安装/GitHub 操作那样拆细分类——截屏本来
// 就不常发生，没必要再按来源（Bash/Read/MCP）拆成好几张卡片，下钻列表里每一行的
// 工具名本身就能看出是哪种来源。
function screenshotStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND cc_is_screenshot(tool_name, detail) = 1`).get().n;
    return { total };
  }, { total: 0 });
}

function screenshotDetails(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND cc_is_screenshot(tool_name, detail) = 1
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// 工具调用统计——"审计事件总数"是 hook_pre + hook_post + os_net 全部加一起的，
// 同一次工具调用至少算两条（pre 一条、post 一条），这里只数 hook_pre，对应的是
// "Claude Code 真的发起过多少次工具调用"这个更直观的数字。
function toolCallStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre'`).get().n;
    return { total };
  }, { total: 0 });
}

// 首页"工具调用"卡片下钻：按工具名分组的次数明细（不是每条事件平铺列出来——
// 光是"调用过多少次 Bash"这种数字，比翻一屏事件列表更有信息量）。
function toolCallBreakdown(limit = 100) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT tool_name, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre'
         GROUP BY tool_name ORDER BY n DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// MCP 工具调用——Claude Code 给 MCP server 提供的工具统一命名成
// `mcp__<server>__<tool>` 这个格式，不用另外维护一份 MCP server 列表，直接按
// tool_name 前缀识别就行。
const MCP_TOOL_PATTERN = "mcp\\_\\_%";

function mcpCallStats() {
  return withDb((db) => {
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name LIKE ? ESCAPE '\\'`)
      .get(MCP_TOOL_PATTERN).n;
    return { total };
  }, { total: 0 });
}

// 首页"MCP 调用"卡片下钻：按 MCP server 分组（从 tool_name 里 mcp__<server>__<tool>
// 这个约定格式解析出 server 名字），而不是按具体工具名——同一个 server 底下可能有
// 十几个工具，按 server 汇总更容易看出"到底在跟哪个 MCP 服务打交道"。
function mcpCallBreakdown(limit = 100) {
  return withDb((db) => {
    const rows = db
      .prepare(`SELECT tool_name, COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name LIKE ? ESCAPE '\\' GROUP BY tool_name`)
      .all(MCP_TOOL_PATTERN);
    const byServer = new Map();
    for (const r of rows) {
      const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(r.tool_name);
      const server = m ? m[1] : r.tool_name;
      byServer.set(server, (byServer.get(server) || 0) + r.n);
    }
    return [...byServer.entries()]
      .map(([server, n]) => ({ server, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, limit);
  }, []);
}

// Skill 调用——跟 MCP 调用同一个思路，只是分组用的不是 tool_name 前缀，而是
// tool_input 里的 skill 字段本身（`Skill` 这个工具名固定不变，具体调用的是哪个
// skill 全在 detail.skill 里）。SQLite 自带的 json_extract 直接在 SQL 里取，
// 不用先把每一行 detail 都读出来在 JS 里 JSON.parse 一遍。
function skillCallStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name = 'Skill'`).get().n;
    return { total };
  }, { total: 0 });
}

function skillCallBreakdown(limit = 100) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT COALESCE(json_extract(detail, '$.skill'), '?') AS skill, COUNT(*) AS n
         FROM events WHERE source = 'hook_pre' AND tool_name = 'Skill'
         GROUP BY skill ORDER BY n DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// 工具调用/MCP 调用卡片下钻里点进某个具体工具名之后的事件明细，跟 fileOpDetails/
// installDetails 是同一个套路。
function toolCallDetails(toolName, limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND tool_name = ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(toolName, limit);
  }, []);
}

// 工具调用/MCP 调用/Skill 调用这三张卡片下钻的"事件明细"部分——按工具名分组的次数
// 只能看出"用得多不多"，看不出"具体是哪个 session、哪个目录、什么时候调用的"，
// 这三个函数专门补这块：平铺列出最近的事件，带 Session ID/cwd/时间戳。
function toolCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(`SELECT id, ts, session_id, cwd, tool_name FROM events WHERE source = 'hook_pre' ORDER BY id DESC LIMIT ?`)
      .all(limit);
  }, []);
}

function mcpCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name FROM events
         WHERE source = 'hook_pre' AND tool_name LIKE ? ESCAPE '\\'
         ORDER BY id DESC LIMIT ?`
      )
      .all(MCP_TOOL_PATTERN, limit);
  }, []);
}

function skillCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, COALESCE(json_extract(detail, '$.skill'), '?') AS skill FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Skill'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// AI 轨迹卡片下钻的事件明细部分——两种不同性质的证据拼在一起，靠 inferred 字段
// 区分：
//   - 探针实测（source='os_net'，inferred=false）：探针只在内核层面看到 pid/uid，
//     天生不知道"这属于 Claude Code 的哪个 session"，所以 sessionId/cwd 在这些行
//     里永远是空的，不是查询漏了字段——前端要如实显示"不可用"，不能编一个假的
//     出来。能给的是时间戳和 pid（探针观测到的进程号，勉强算是"哪个进程"的线索）。
//   - 命令文本推断（inferred=true）：来自 commandNetworkHosts()，有 sessionId/cwd/
//     具体命令，但没有 pid（这条命令有没有真的连通、连的是不是文本里那个 host，
//     都只是"看起来像"，不是探针那种内核级别的确认）。
function networkConnectEvents(limit = 300) {
  const observed = withDb((db) => {
    const rows = db
      .prepare(`SELECT id, ts, tool_name, detail FROM events WHERE source = 'os_net' ORDER BY id DESC LIMIT ?`)
      .all(limit);
    return rows.map((r) => {
      let detail = {};
      try {
        detail = r.detail ? JSON.parse(r.detail) : {};
      } catch (e) {
        detail = {};
      }
      return {
        id: r.id,
        ts: r.ts,
        comm: r.tool_name,
        pid: detail.pid,
        ip: detail.ip,
        port: detail.port,
        host: detail.host,
        inferred: false,
      };
    });
  }, []);
  const inferred = commandNetworkHosts(limit).map((e) => ({
    id: "cmd-" + e.id + "-" + e.host,
    ts: e.ts,
    comm: e.command,
    pid: null,
    ip: null,
    port: null,
    host: e.host,
    sessionId: e.sessionId,
    cwd: e.cwd,
    inferred: true,
  }));
  return observed
    .concat(inferred)
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .slice(0, limit);
}

// "审计事件总数"下钻：按 工具/来源 分组，并且列出每个分组具体是哪些 session 产生的。
function eventTypeBreakdown(limit = 500) {
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT source, tool_name, session_id, COUNT(*) AS n
         FROM events
         GROUP BY source, tool_name, session_id
         ORDER BY n DESC`
      )
      .all();
    const byType = new Map();
    for (const r of rows) {
      const key = `${r.source}::${r.tool_name || ""}`;
      if (!byType.has(key)) {
        byType.set(key, { source: r.source, toolName: r.tool_name, total: 0, sessions: [] });
      }
      const entry = byType.get(key);
      entry.total += r.n;
      if (r.session_id) entry.sessions.push({ sessionId: r.session_id, count: r.n });
    }
    return [...byType.values()].sort((a, b) => b.total - a.total).slice(0, limit);
  }, []);
}

// "拦截的高危操作"下钻：具体是哪些命令/操作被挡下来的。
function blockedDetails(limit = 200) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail
         FROM events WHERE decision = 'blocked'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

module.exports = {
  listSessions,
  queryEvents,
  stats,
  dbPath,
  getTranscriptPath,
  fileOpsStats,
  fileOpDetails,
  installStats,
  installDetails,
  githubOpsStats,
  githubOpsDetails,
  sshOpsStats,
  sshOpsDetails,
  downloadOpsStats,
  downloadOpsDetails,
  screenshotStats,
  screenshotDetails,
  commandNetworkHosts,
  toolCallStats,
  toolCallBreakdown,
  mcpCallStats,
  mcpCallBreakdown,
  skillCallStats,
  skillCallBreakdown,
  toolCallDetails,
  toolCallEvents,
  mcpCallEvents,
  skillCallEvents,
  networkConnectEvents,
  eventTypeBreakdown,
  blockedDetails,
};
