"use strict";
const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const url = require("url");
const { WebSocketServer } = require("ws");

const { SessionManager } = require("./lib/sessions");
const audit = require("./lib/audit");
const fmt = require("./lib/format");
const status = require("./lib/status");
const transcript = require("./lib/transcript");
const usage = require("./lib/usage");
const archives = require("./lib/archives");
const auditState = require("./lib/auditState");
const browse = require("./lib/browse");
const remoteAccess = require("./lib/remoteAccess");
const approvals = require("./lib/approvals");

// 默认只绑定 localhost：这是一个能直接开终端 spawn 进程的工具，绝不能不加认证就暴露到
// 公网/局域网。这个默认值不会被 UI 上的"允许远程访问"开关自动改掉——真要监听所有网卡，
// 得管理员自己显式设置 CC_MONITOR_WEBUI_HOST=0.0.0.0 再重启进程，安全边界始终是进程
// 启动时就定死的监听地址，不是运行时能被网页动态改掉的一个标志位。
// UI 开关（remoteAccess）管的是另一件事：即使显式绑成了 0.0.0.0，下面的中间件/
// WebSocket upgrade 也会先查这个开关，默认关（拒绝非本机来源），开了才放行——
// 相当于给"我确实想监听所有网卡"这个场景再加一道默认是关的应用层闸门。
const HOST = process.env.CC_MONITOR_WEBUI_HOST || "127.0.0.1";
const PORT = parseInt(process.env.CC_MONITOR_WEBUI_PORT || "9999", 10);

const app = express();
app.use(express.json());

// 访问控制闸门：不是本机来源、且"允许远程访问"开关没打开的请求，一律 403，碰不到
// 下面任何一条路由/静态文件。放在最前面，对所有请求都生效。默认绑定 127.0.0.1 时
// 这道检查其实永远不会拦到任何东西（只有本机才连得上 socket），只有管理员显式把
// HOST 改成 0.0.0.0 之后，这里才是真正起作用的那道闸门。
app.use((req, res, next) => {
  const addr = req.socket.remoteAddress;
  if (remoteAccess.isLocalAddress(addr) || remoteAccess.getState().allowRemote) return next();
  res.status(403).type("text/plain").send("Forbidden: remote access to CC-Monitor is disabled. Enable it from the Home tab (from the local machine), or connect from 127.0.0.1.");
});

// 这个 UI 还在快速迭代，public/ 底下的文件随时会变；不加 no-store 的话浏览器可能
// 拿着缓存的旧 app.js/index.html 不去问服务器，改了东西却"看起来没生效"，很难排查。
const noCacheStatic = (dir) => express.static(dir, { etag: false, lastModified: false, setHeaders: (res) => res.setHeader("Cache-Control", "no-store") });

// `Cache-Control: no-store` 只对"守规矩、会去读这个响应头"的缓存有效——浏览器磁盘缓存、
// 中间的透明代理（这台机器上就跑着一个 mihomo/Clash，如果客户端把 127.0.0.1 也走了代理，
// 代理自己的缓存策略就不一定尊重源站的 Cache-Control 了）都可能对不上号，表现就是"服务端
// 文件明明改了/重启了，页面却死活还是旧的"。这里给 index.html 里引用的几个核心脚本/样式
// 加一个跟着进程启动时间变的版本号（`?v=<timestamp>`），换了 URL 的资源对任何缓存来说都是
// "新对象"，不用靠对方老老实实遵守 no-store。
const ASSET_VERSION = String(Date.now());
app.get("/", (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  html = html.replace(
    /(src|href)="(\/(?:app|i18n)\.js|\/style\.css)"/g,
    (m, attr, p) => `${attr}="${p}?v=${ASSET_VERSION}"`
  );
  res.set("Cache-Control", "no-store");
  res.type("html").send(html);
});

app.use(noCacheStatic(path.join(__dirname, "public")));
app.use("/vendor/xterm", noCacheStatic(path.join(__dirname, "node_modules/xterm")));
app.use("/vendor/xterm-addon-fit", noCacheStatic(path.join(__dirname, "node_modules/xterm-addon-fit/lib")));
app.use("/vendor/xterm-addon-webgl", noCacheStatic(path.join(__dirname, "node_modules/xterm-addon-webgl/lib")));

const sessions = new SessionManager();

// ---- REST API: 终端会话管理 ----

// Web UI 自己开的 PTY 会话（sessions.list() 里的 id）跟 hooks 记录的 Claude Code
// session_id 是两套完全不相关的 id——PTY 那个是我们自己 crypto.randomUUID() 出来的，
// Claude Code 自己另外生成它的 session_id，两边没有天然的对应关系。只能靠 cwd 相同
// 这个弱关联去猜：同一个工作目录里，活动时间最新的那个审计 session，大概率就是这个
// PTY 里跑着的那个 claude 进程——不保证 100% 准确（同一个目录被开了好几次的话可能猜错），
// 但足够在首页"进行中"这张下钻详情里顺带显示一下模型/事件数，不做成分开另查的功能。
// 状态标记（working/blocked/idle），跟 herdr "每个 pane 标状态、不用到处找卡住的
// 那个" 是同一个思路——不是另起一套检测机制，直接复用已经有的两个数据源：
// 有没有待处理的审批请求（pending_approvals，谁先出现就是 blocked，最该优先看的）；
// 终端最近有没有真输出过东西、或者审计事件最近有没有新记录（两个但凡一个命中就算
// 在正常干活）；两个都没有就是 idle——大概率是停在提示符前等你打字，不是卡住了。
const RECENT_ACTIVITY_MS = 30 * 1000;
function computeSessionStatus(s, matchedAuditSessionId, matchedLastTs, pendingSessionIds) {
  if (matchedAuditSessionId && pendingSessionIds.has(matchedAuditSessionId)) return "blocked";
  const now = Date.now();
  const recentOutput = s.lastOutputAt && now - s.lastOutputAt < RECENT_ACTIVITY_MS;
  const recentEvent = matchedLastTs && now - new Date(matchedLastTs).getTime() < RECENT_ACTIVITY_MS;
  return recentOutput || recentEvent ? "working" : "idle";
}

app.get("/api/sessions", (req, res) => {
  const live = sessions.list();
  const auditRows = audit.listSessions();
  const pendingSessionIds = new Set(approvals.listPending().map((r) => r.session_id));
  const enriched = live.map((s) => {
    const candidates = auditRows.filter((r) => r.cwd === s.cwd);
    candidates.sort((a, b) => (a.last_ts < b.last_ts ? 1 : -1));
    const match = candidates[0];
    return {
      ...s,
      auditSessionId: match ? match.session_id : null,
      eventCount: match ? match.event_count : null,
      model: match && match.transcript_path ? transcript.getModel(match.transcript_path) : null,
      status: s.alive ? computeSessionStatus(s, match ? match.session_id : null, match ? match.last_ts : null, pendingSessionIds) : "dead",
    };
  });
  res.json(enriched);
});

app.post("/api/sessions", (req, res) => {
  const { cwd } = req.body || {};
  const session = sessions.create({ cwd });
  res.json({ id: session.id, cwd: session.cwd, createdAt: session.createdAt });
});

app.delete("/api/sessions/:id", (req, res) => {
  const ok = sessions.kill(req.params.id);
  res.json({ ok });
});

// ---- REST API: "新建会话"弹窗里选工作目录用的文件夹浏览器 ----
app.get("/api/browse-dir", (req, res) => {
  const result = browse.listDir(req.query.path);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ---- REST API: 是否允许其它设备访问这个 Web UI ----
// listeningHost 告诉前端这个进程实际绑定在哪个地址上——如果还是 127.0.0.1，
// 下面 allowRemote 这个标志位改了也不会真正生效，得管理员显式设 CC_MONITOR_WEBUI_HOST
// =0.0.0.0 重启进程才行；前端拿这个字段判断要不要提示"这个开关现在还没真正生效"。
app.get("/api/remote-access-state", (req, res) => {
  res.json({ ...remoteAccess.getState(), listeningHost: HOST });
});

app.post("/api/remote-access-state", (req, res) => {
  const { allowRemote } = req.body || {};
  res.json({ ...remoteAccess.setState(allowRemote), listeningHost: HOST });
});

// ---- REST API: 待批准的 confirm 类操作（跟触发它的终端里能直接按 y/N 是同一件事的
// 另一条路，谁先给出结果就用谁的，见 cc_monitor/notify.py 的 confirm()） ----

app.get("/api/pending-approvals", (req, res) => {
  res.json(approvals.listPending());
});

app.post("/api/pending-approvals/:id/resolve", (req, res) => {
  const { decision } = req.body || {};
  const result = approvals.resolve(parseInt(req.params.id, 10), decision);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// ---- REST API: 审计日志 ----

app.get("/api/log-sessions", (req, res) => {
  const rows = audit.listSessions().map((r) => ({
    ...r,
    model: r.transcript_path ? transcript.getModel(r.transcript_path) : null,
    has_transcript: !!r.transcript_path,
  }));
  res.json(rows);
});

// ---- REST API: Claude Tap（发给/收到模型的完整对话内容） ----

app.get("/api/transcript", (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: "缺少 session_id" });

  const transcriptPath = audit.getTranscriptPath(sessionId);
  if (!transcriptPath) {
    return res.json({ entries: [], nextLine: 0, transcriptPath: null, totalLines: 0 });
  }
  // hook payload 里的 transcript_path 是 Claude Code 自己上报的"它打算/正在写到哪个文件"，
  // 不代表这个文件一定真的存在——有些执行上下文（比如某些一次性的工具调用、后台任务）
  // 压根没有落盘常规的 project transcript。这种情况要明确告诉前端"文件不存在"，
  // 不然前端会一直显示"0 · 那个路径"、卡在"加载中"，看起来像是卡死了，其实是没有数据源。
  if (!fs.existsSync(transcriptPath)) {
    return res.json({ entries: [], nextLine: 0, transcriptPath, totalLines: 0, missing: true });
  }

  const sinceLineRaw = req.query.since_line;
  const limit = Math.min(parseInt(req.query.limit || "300", 10), 2000);
  // since_line 没传或是 0，代表这是刚选中这个会话的第一次拉取——给"最近在做什么"
  // （从文件尾部往前找），不是从第一行开始翻旧账，不然几万行的长会话看到的全是好几天前
  // 的历史消息，跟"实时"完全不沾边。后续轮询用的 since_line 都是上次返回的 nextLine
  // （必然 > 0），走正常的增量正向读取。
  const { entries, nextLine } =
    !sinceLineRaw || sinceLineRaw === "0"
      ? transcript.readTailEntries(transcriptPath, limit)
      : transcript.readEntries(transcriptPath, parseInt(sinceLineRaw, 10), limit);
  res.json({
    entries: entries.map(transcript.renderEntryHtml),
    nextLine,
    transcriptPath,
    totalLines: transcript.countLines(transcriptPath),
  });
});

// Claude Tap"全部会话"合并视图：每个有 transcript 的 session 各取最近若干条，
// 按时间戳合并排序、打上是哪个 session 的标签。不做增量轮询游标（每次都是重新读一遍
// 每个 session 的尾部）——session 数量对个人监测工具来说通常是个位数到十几个，
// 简单直接比维护一套多文件的增量游标划算得多。
app.get("/api/transcript/all", (req, res) => {
  const perSessionLimit = Math.min(parseInt(req.query.per_session_limit || "30", 10), 200);
  const overallLimit = Math.min(parseInt(req.query.limit || "200", 10), 1000);

  const sessions = audit.listSessions().filter((r) => r.transcript_path);
  let merged = [];
  for (const s of sessions) {
    if (!fs.existsSync(s.transcript_path)) continue;
    const { entries } = transcript.readTailEntries(s.transcript_path, perSessionLimit);
    const model = transcript.getModel(s.transcript_path);
    for (const e of entries) {
      merged.push({
        ...transcript.renderEntryHtml(e),
        sessionId: s.session_id,
        cwd: s.cwd,
        model,
      });
    }
  }
  merged.sort((a, b) => (a.ts < b.ts ? 1 : -1)); // 新的在前，跟单会话视图的顺序一致
  merged = merged.slice(0, overallLimit);
  res.json({ entries: merged, sessionCount: sessions.length });
});

// ---- REST API: 账号级用量/额度（跟 ccstatusline 读同一份 Claude Code OAuth 凭证） ----

app.get("/api/usage", async (req, res) => {
  const result = await usage.getUsage();
  res.json(result);
});

app.get("/api/logs", (req, res) => {
  const sinceId = parseInt(req.query.since_id || "0", 10);
  const limit = Math.min(parseInt(req.query.limit || "300", 10), 2000);
  const rows = audit.queryEvents({ sessionId: req.query.session_id || null, sinceId, limit });
  const events = rows.map((row) => {
    let detail = {};
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      detail = {};
    }
    const { label, summaryHtml, extra } = fmt.describe(row.tool_name, row.source, detail);
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      source: row.source,
      stageLabel: fmt.stageLabel(row.source),
      toolName: row.tool_name,
      cwd: row.cwd,
      risk: row.risk || "-",
      matchedRule: row.matched_rule,
      decision: row.decision,
      label,
      summaryHtml,
      extra,
    };
  });
  res.json({ events, dbPath: audit.dbPath() });
});

app.get("/api/stats", (req, res) => {
  res.json(audit.stats());
});

// ---- REST API: 首页概览 + 状态信息面板 ----

app.get("/api/overview", (req, res) => {
  const s = audit.stats();
  res.json({
    ...s,
    liveSessionCount: sessions.list().filter((x) => x.alive).length,
    fileOps: audit.fileOpsStats(),
    installOps: audit.installStats(),
  });
});

// ---- REST API: 首页统计卡片的下钻详情 ----

app.get("/api/drilldown/sessions", (req, res) => {
  const rows = audit.listSessions().map((r) => ({
    sessionId: r.session_id,
    cwd: r.cwd,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    eventCount: r.event_count,
    blockedCount: r.blocked_count,
    bypassCount: r.bypass_count,
    model: r.transcript_path ? transcript.getModel(r.transcript_path) : null,
  }));
  res.json(rows);
});

app.get("/api/drilldown/event-types", (req, res) => {
  res.json(audit.eventTypeBreakdown());
});

app.get("/api/drilldown/blocked", (req, res) => {
  const rows = audit.blockedDetails().map((row) => {
    let detail = {};
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      detail = {};
    }
    const { label, summaryHtml } = fmt.describe(row.tool_name, "hook_pre", detail);
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      cwd: row.cwd,
      toolName: row.tool_name,
      matchedRule: row.matched_rule,
      label,
      summaryHtml,
    };
  });
  res.json(rows);
});

app.get("/api/drilldown/file-op/:type", (req, res) => {
  const type = req.params.type;
  if (!["read", "write", "edit", "delete"].includes(type)) {
    return res.status(400).json({ error: "type 必须是 read/write/edit/delete 之一" });
  }
  const rows = audit.fileOpDetails(type).map((row) => {
    let detail = {};
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      detail = {};
    }
    const { label, summaryHtml } = fmt.describe(row.tool_name, "hook_pre", detail);
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      cwd: row.cwd,
      toolName: row.tool_name,
      matchedRule: row.matched_rule,
      label,
      summaryHtml,
    };
  });
  res.json(rows);
});

app.get("/api/drilldown/install-op/:type", (req, res) => {
  const type = req.params.type;
  if (!["pip", "system", "npm", "other"].includes(type)) {
    return res.status(400).json({ error: "type 必须是 pip/system/npm/other 之一" });
  }
  const rows = audit.installDetails(type).map((row) => {
    let detail = {};
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      detail = {};
    }
    const { label, summaryHtml } = fmt.describe(row.tool_name, "hook_pre", detail);
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      cwd: row.cwd,
      toolName: row.tool_name,
      matchedRule: row.matched_rule,
      label,
      summaryHtml,
    };
  });
  res.json(rows);
});

// ---- REST API: 数据归档（把当前事件数据存档）/ 清空当前事件数据 / 历史归档列表 ----

app.get("/api/archives", (req, res) => {
  res.json(archives.listArchives());
});

app.post("/api/archives", async (req, res) => {
  const { label } = req.body || {};
  const result = await archives.createArchive(label);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.delete("/api/archives/:id", (req, res) => {
  const result = archives.deleteArchive(req.params.id);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

// 打开一份历史归档具体看里面的事件——跟 /api/logs 返回的事件形状完全一样，
// 前端可以直接复用同一套 renderLogItem() 渲染逻辑，不用另外写一套。
app.get("/api/archives/:id/events", (req, res) => {
  const sinceId = parseInt(req.query.since_id || "0", 10);
  const limit = Math.min(parseInt(req.query.limit || "500", 10), 2000);
  const rows = archives.getArchiveEvents(req.params.id, { sinceId, limit });
  if (rows === null) return res.status(404).json({ error: "归档不存在或对应的文件已丢失" });
  const events = rows.map((row) => {
    let detail = {};
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      detail = {};
    }
    const { label, summaryHtml, extra } = fmt.describe(row.tool_name, row.source, detail);
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      source: row.source,
      stageLabel: fmt.stageLabel(row.source),
      toolName: row.tool_name,
      cwd: row.cwd,
      risk: row.risk || "-",
      matchedRule: row.matched_rule,
      decision: row.decision,
      label,
      summaryHtml,
      extra,
    };
  });
  res.json({ events });
});

app.post("/api/events/clear", (req, res) => {
  const result = archives.clearCurrentEvents();
  res.json(result);
});

// ---- REST API: 审计开关（开始/暂停/停止）----

app.get("/api/audit-state", (req, res) => {
  res.json(auditState.getState());
});

app.post("/api/audit-state", (req, res) => {
  const { state } = req.body || {};
  try {
    res.json(auditState.setState(state));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/status", (req, res) => {
  const liveSessions = sessions.list().map((s) => {
    const g = status.gitInfo(s.cwd);
    return {
      kind: "webui",
      id: s.id,
      cwd: s.cwd,
      alive: s.alive,
      exitCode: s.exitCode,
      uptimeMs: Date.now() - s.createdAt,
      gitBranch: g.branch,
      gitDirty: g.dirty,
    };
  });
  const auditSessions = audit.listSessions(50).map((r) => {
    const g = status.gitInfo(r.cwd);
    const tokenStats = r.transcript_path ? transcript.getTokenStats(r.transcript_path) : null;
    return {
      kind: "audit",
      sessionId: r.session_id,
      cwd: r.cwd,
      firstTs: r.first_ts,
      lastTs: r.last_ts,
      eventCount: r.event_count,
      blockedCount: r.blocked_count,
      bypassCount: r.bypass_count,
      gitBranch: g.branch,
      gitDirty: g.dirty,
      model: r.transcript_path ? transcript.getModel(r.transcript_path) : null,
      tokenStats,
    };
  });
  res.json({ liveSessions, auditSessions });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // WebSocket 的 upgrade 走的是 http.Server 原生事件，不经过 Express 中间件链，
  // 上面那道 app.use 闸门管不到这里——这条终端 PTY 通道恰恰是风险最高的一个
  // （直接就是个 shell），必须单独在这里也拦一遍，不能只挡 HTTP 路由。
  const addr = socket.remoteAddress;
  if (!remoteAccess.isLocalAddress(addr) && !remoteAccess.getState().allowRemote) {
    socket.destroy();
    return;
  }
  const { pathname, query } = url.parse(req.url, true);
  if (pathname !== "/ws/terminal") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.sessionId = query.id;
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  const session = sessions.get(ws.sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: "error", message: "会话不存在或已结束" }));
    ws.close();
    return;
  }

  session.clients.add(ws);
  // 把已有的 scrollback 一次性回放给刚连上的客户端。
  if (session.scrollback.length) {
    ws.send(JSON.stringify({ type: "data", data: session.scrollback.join("") }));
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (msg.type === "input") {
      sessions.write(session.id, msg.data);
    } else if (msg.type === "resize") {
      sessions.resize(session.id, msg.cols, msg.rows);
    }
  });

  ws.on("close", () => {
    session.clients.delete(ws);
  });
});

server.listen(PORT, HOST, () => {
  const accessNote = HOST === "127.0.0.1" ? "（仅本机可访问）" : `（已绑定 ${HOST}，"允许远程访问"开关的实际状态见首页）`;
  console.log(`[CC-Monitor WebUI] 监听 http://${HOST}:${PORT} ${accessNote}`);
  console.log(`[CC-Monitor WebUI] 审计日志读取自: ${audit.dbPath()}`);
});
