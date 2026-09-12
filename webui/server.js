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

// 只绑定 localhost：这是一个能直接开终端 spawn 进程的工具，绝不能不加认证就暴露到公网/局域网。
const HOST = process.env.CC_MONITOR_WEBUI_HOST || "127.0.0.1";
const PORT = parseInt(process.env.CC_MONITOR_WEBUI_PORT || "9999", 10);

const app = express();
app.use(express.json());
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

app.get("/api/sessions", (req, res) => {
  res.json(sessions.list());
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
  console.log(`[CC-Monitor WebUI] 监听 http://${HOST}:${PORT} （仅本机可访问）`);
  console.log(`[CC-Monitor WebUI] 审计日志读取自: ${audit.dbPath()}`);
});
