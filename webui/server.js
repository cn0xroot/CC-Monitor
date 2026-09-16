"use strict";
const express = require("express");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const url = require("url");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");

const { SessionManager } = require("./lib/sessions");
const audit = require("./lib/audit");
const fmt = require("./lib/format");
const status = require("./lib/status");
const transcript = require("./lib/transcript");
const usage = require("./lib/usage");
const account = require("./lib/account");
const archives = require("./lib/archives");
const auditState = require("./lib/auditState");
const rulesMeta = require("./lib/rules");
const browse = require("./lib/browse");
const remoteAccess = require("./lib/remoteAccess");
const approvals = require("./lib/approvals");
const processScan = require("./lib/processScan");
const network = require("./lib/network");
const geoip = require("./lib/geoip");

// 这个进程里活着好几个终端 PTY 会话——任何一个请求/WS 消息里冒出来的未捕获异常，
// Node 默认行为是直接把整个进程干掉，等于所有终端会话（不管跟那个异常有没有关系）
// 全部瞬间消失，用户毫无预兆地"突然就没了"。这里跟 cc_monitor 的 hook.py 同一个
// 思路："fail open"：记下来，但绝不能让一次意外把所有活着的会话陪葬。
process.on("uncaughtException", (err) => {
  console.error("[CC-Monitor WebUI] 未捕获异常（已忽略，继续运行）:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[CC-Monitor WebUI] 未处理的 Promise rejection（已忽略，继续运行）:", err);
});

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

// 跟上面那个 RECENT_ACTIVITY_MS（30 秒）是同一个"working/idle"思路，但用在一个不同的
// 数据源上：Web UI 终端的 PTY 每敲一个字符都会有输出，30 秒足够灵敏；被动监测到的
// 外部终端会话（这里说的"会话列表"/"claude 进程明细"）只在真的调用工具的那一刻才有
// 事件，模型"思考"、用户读输出的间隙完全正常能有几十秒到几分钟的空档，卡太紧的话
// 大部分正常在工作的会话都会被误判成"空闲"，放宽到 5 分钟。
const WORKING_THRESHOLD_MS = 5 * 60 * 1000;
// 返回的不只是三态本身，还有 agoMs（距上次活跃过了多少毫秒）——working 状态下前端要
// 拿这个算"心跳有多深"：5 分钟内越新鲜颜色越深、心电图波形摆动越大，快到 5 分钟
// 边界时逐渐收敛成最浅的红，而不是一到 5 分钟就从"最深红"直接跳成"灰"。
function vitalStatus(hasLiveProcess, lastTs) {
  if (!hasLiveProcess) return { status: "dead", agoMs: null };
  const agoMs = lastTs ? Date.now() - new Date(lastTs).getTime() : null;
  if (agoMs !== null && agoMs < WORKING_THRESHOLD_MS) return { status: "working", agoMs };
  return { status: "idle", agoMs };
}

// PTY 那边记的 cwd 是我们建终端时传给 pty.spawn() 的原始字符串；hook.py 那边记的
// cwd 是 Python os.getcwd() 的返回值——如果目录路径里带符号链接，两边即使指的是
//同一个目录，字符串也可能不完全一样（前者不解析符号链接，后者会），导致精确字符串
// 比较误判为"匹配不到"，从而模型/事件数这些本该有数据的字段全变成空的。用
// realpath 兜底：能 resolve 就按 resolve 后的比，resolve 不了（目录已经不存在了）
// 就退回原始字符串比较。
function normCwd(p, cache) {
  if (!p) return p;
  if (cache.has(p)) return cache.get(p);
  let resolved;
  try {
    resolved = fs.realpathSync(p);
  } catch (e) {
    resolved = path.normalize(p).replace(/\/+$/, "") || p;
  }
  cache.set(p, resolved);
  return resolved;
}

app.get("/api/sessions", (req, res) => {
  const live = sessions.list();
  const auditRows = audit.listSessions();
  const pendingSessionIds = new Set(approvals.listPending().map((r) => r.session_id));
  const cwdCache = new Map(); // 一次请求内，同一个路径字符串只 realpath 一次
  const enriched = live.map((s) => {
    const sCwd = normCwd(s.cwd, cwdCache);
    const candidates = auditRows.filter((r) => normCwd(r.cwd, cwdCache) === sCwd);
    candidates.sort((a, b) => (a.last_ts < b.last_ts ? 1 : -1));
    const match = candidates[0];
    return {
      ...s,
      auditSessionId: match ? match.session_id : null,
      eventCount: match ? match.event_count : null,
      blockedCount: match ? match.blocked_count : null,
      bypassCount: match ? match.bypass_count : null,
      firstTs: match ? match.first_ts : null,
      lastTs: match ? match.last_ts : null,
      model: match && match.transcript_path ? transcript.getModel(match.transcript_path) : null,
      status: s.alive ? computeSessionStatus(s, match ? match.session_id : null, match ? match.last_ts : null, pendingSessionIds) : "dead",
      // 距上次活跃多久——前端的"生命体征"指示器靠它算心跳颜色深浅和波形摆动幅度。
      // 漏了这个字段的话 vitalHeat() 拿到 undefined 一律返回 0，不管多活跃都画成
      // 灰色直线（这正是"健康状态没有红色"那个 bug）。两个活跃信号取更近的那个：
      // PTY 真的吐过字（lastOutputAt），或者这个 cwd 底下有新的审计事件（last_ts）。
      statusAgoMs: (() => {
        if (!s.alive) return null;
        const outputAt = s.lastOutputAt || 0;
        const eventAt = match && match.last_ts ? new Date(match.last_ts).getTime() : 0;
        const latest = Math.max(outputAt, eventAt);
        return latest ? Date.now() - latest : null;
      })(),
    };
  });
  res.json(enriched);
});

app.post("/api/sessions", (req, res) => {
  const { cwd, launchClaude } = req.body || {};
  // launchClaude 不传就是 true（"新建会话"的默认行为，保持原样）；"新建窗口"
  // 显式传 false，要一个不自动敲 claude 的裸 shell。
  const session = sessions.create({ cwd, launchClaude: launchClaude !== false });
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

app.get("/api/approvals/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "200", 10), 2000);
  res.json(approvals.listHistory(limit));
});

// ---- REST API: claude 进程运行身份检测（Web UI 和你终端里的 claude 是不是同一个
// 操作系统用户——不是同一个用户的话，两边各写各的 ~/.cc-monitor/ 数据库，这个接口
// 就是用来把这种情况暴露出来的） ----

app.get("/api/claude-processes", async (req, res) => {
  const procs = await processScan.scanClaudeProcesses();
  // 一个"正在跑"的 claude 进程本身不带时间戳（ps 只有进程启动时间，不是"最后一次
  // 真的干了点什么"）——按 cwd 比对审计日志里最近一条事件的时间，当作"最近活跃"的
  // 近似值：进程在跑但迟迟没有新事件，大概率是空闲在等用户输入，不是 bug。
  const cwdCache = new Map();
  const auditRows = audit.listSessions();
  const lastEventByCwd = new Map();
  for (const r of auditRows) {
    if (!r.cwd) continue;
    const key = normCwd(r.cwd, cwdCache);
    const prev = lastEventByCwd.get(key);
    if (!prev || r.last_ts > prev) lastEventByCwd.set(key, r.last_ts);
  }
  // 进程本身不知道自己在用哪个模型——模型只写在 transcript 里。按 cwd 找到该目录下
  // 最近那个会话，用它的 transcript 解析出模型 ID 和 session id。同一个目录先后开过
  // 好几个会话时取最近的一个（auditRows 已按 last_ts 倒序）。
  const sessionByCwd = new Map();
  for (const r of auditRows) {
    if (!r.cwd) continue;
    const key = normCwd(r.cwd, cwdCache);
    if (!sessionByCwd.has(key)) sessionByCwd.set(key, r);
  }
  const enriched = procs.map((p) => {
    const lastEventTs = p.cwd ? lastEventByCwd.get(normCwd(p.cwd, cwdCache)) || null : null;
    const sess = p.cwd ? sessionByCwd.get(normCwd(p.cwd, cwdCache)) : null;
    // 这里永远不会是 "dead"——能进这个列表就说明进程这一刻真的在跑，vitalStatus() 的
    // 第一个参数写死 true，只用它来区分 working（最近有审计事件）还是 idle（挂着但没动静）。
    const v = vitalStatus(true, lastEventTs);
    return {
      ...p,
      lastEventTs,
      status: v.status,
      statusAgoMs: v.agoMs,
      model: sess && sess.transcript_path ? transcript.getModel(sess.transcript_path) : null,
      sessionId: sess ? sess.session_id : null,
      eventCount: sess ? sess.event_count : null,
    };
  });
  res.json(processScan.summarize(enriched, os.userInfo().username));
});

// ---- REST API: Claude Code 网络流量（数据来自系统层探针，Linux + eBPF 才有；
// 没装/没在跑探针的话这几个接口如实返回空数据，不是 bug） ----

// 归属地城市/国家名要跟着页面语言走（MaxMind GeoLite2 的 names 字段本身就是多语言
// 对象），前端把当前 UI 语言（"zh"/"en"）通过 ?lang= 传过来，不认的值一律按 en 处理。
function geoLang(req) {
  return req.query.lang === "zh" ? "zh" : "en";
}

app.get("/api/network-traffic", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "200", 10), 2000);
  const [rows, sum, geoStatus] = await Promise.all([
    network.listTraffic(limit, geoLang(req)),
    network.summary(),
    geoip.getStatus(),
  ]);
  res.json({ rows, summary: sum, geo: geoStatus });
});

app.get("/api/network-traffic/geopairs", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "500", 10), 2000);
  const pairs = await network.geoPairs(limit, geoLang(req));
  res.json({ pairs });
});

app.get("/api/geoip-status", async (req, res) => {
  res.json(await geoip.getStatus());
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

// 规则元信息：id -> {title, desc, title_en, desc_en, risk, action}，审批台用来把规则 id
// 翻译成"这是要确认什么操作"的通俗说明。
app.get("/api/rules/meta", (req, res) => {
  res.json(rulesMeta.ruleMeta());
});

app.get("/api/usage", async (req, res) => {
  const result = await usage.getUsage();
  res.json(result);
});

app.get("/api/account", (req, res) => {
  res.json(account.getAccountInfo());
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

// GitHub/SSH/下载/Docker/压缩/网络诊断/进程管理这七组首页卡片现在只显示一个汇总
// 数字（点开才看分类明细），汇总数字就是分类小计表 n 字段加总。
function sumN(rows) {
  return rows.reduce((a, r) => a + r.n, 0);
}

app.get("/api/overview", async (req, res) => {
  const s = audit.stats();
  const netSummary = await network.summary();
  res.json({
    ...s,
    liveSessionCount: sessions.list().filter((x) => x.alive).length,
    fileOps: audit.fileOpsStats(),
    installOps: audit.installStats(),
    githubOpsTotal: sumN(audit.githubOpsBreakdown()),
    sshOpsTotal: sumN(audit.sshOpsBreakdown()),
    downloadOpsTotal: sumN(audit.downloadOpsBreakdown()),
    dockerOpsTotal: sumN(audit.dockerOpsBreakdown()),
    archiveOpsTotal: sumN(audit.archiveOpsBreakdown()),
    netdiagOpsTotal: sumN(audit.netdiagOpsBreakdown()),
    reverseEngOpsTotal: sumN(audit.reverseEngOpsBreakdown()),
    procbgOpsTotal: sumN(audit.procbgOpsBreakdown()),
    sensitiveOpsTotal: sumN(audit.sensitiveOpsBreakdown()),
    sensitiveDataTotal: sumN(audit.sensitiveDataBreakdown()),
    advancedThreatTotal: sumN(audit.advancedThreatBreakdown()),
    workdirEscapeTotal: sumN(audit.workdirEscapeBreakdown()),
    workdirEscapeBreakdown: audit.workdirEscapeBreakdown(),
    screenshotOps: audit.screenshotStats(),
    toolCalls: audit.toolCallStats().total,
    mcpCalls: audit.mcpCallStats().total,
    skillCalls: audit.skillCallStats().total,
    subagentCalls: audit.subagentCallStats().total,
    searchCalls: audit.searchCallStats().total,
    todoCalls: audit.todoCallStats().total,
    aiTrajectory: netSummary.distinctIps,
  });
});

// ---- REST API: 首页统计卡片的下钻详情 ----

app.get("/api/drilldown/sessions", async (req, res) => {
  // "活跃/停止"跟 Web UI 终端会话那边的"working/idle"不是一回事——这里的会话大多是
  // 在外部终端里跑的、被 hooks 被动监测到的，工具调用之间隔几分钟很正常，不能用
  // "最近几十秒有没有动静"判断。真正靠谱的信号是"这个 cwd 底下还有没有一个真的在跑的
  // claude 进程"，用跟"检测到的 claude 进程"卡片同一份实时 ps 扫描结果按 cwd 比对
  // （复用 normCwd 的 realpath 归一化，避免符号链接导致误判成"没匹配上"）。
  const cwdCache = new Map();
  const liveProcs = await processScan.scanClaudeProcesses();
  const liveCwds = new Set(liveProcs.map((p) => normCwd(p.cwd, cwdCache)).filter(Boolean));
  const rows = audit.listSessions().map((r) => ({
    sessionId: r.session_id,
    cwd: r.cwd,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    eventCount: r.event_count,
    blockedCount: r.blocked_count,
    bypassCount: r.bypass_count,
    model: r.transcript_path ? transcript.getModel(r.transcript_path) : null,
    // 模型的输入/输出/缓存 token 用量——从这个会话的 transcript 里算（跟"状态信息"页
    // 那张模型用量表同一个 getTokenStats），会话列表里直接能看到每个会话烧了多少。
    tokenStats: r.transcript_path ? transcript.getTokenStats(r.transcript_path) : null,
    active: r.cwd ? liveCwds.has(normCwd(r.cwd, cwdCache)) : false,
    ...(() => {
      const v = vitalStatus(r.cwd ? liveCwds.has(normCwd(r.cwd, cwdCache)) : false, r.last_ts);
      return { status: v.status, statusAgoMs: v.agoMs };
    })(),
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

// GitHub/SSH/下载/Docker/压缩/网络诊断/进程管理这七组，首页现在都是"一张汇总卡片，
// 点开看分类小计 + 事件明细"，接口形状也完全一样（跟 mcp-calls/skill-calls 那几个
// 已有接口是同一个套路），抽成一个通用处理函数。
function opsDrilldownHandler(breakdownFn, eventsFn) {
  return (req, res) => {
    const breakdown = breakdownFn();
    const events = eventsFn().map((row) => {
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
        kind: row.kind,
        label,
        summaryHtml,
      };
    });
    res.json({ breakdown, events });
  };
}

app.get("/api/drilldown/github-ops", opsDrilldownHandler(audit.githubOpsBreakdown, audit.githubOpsEvents));
app.get("/api/drilldown/ssh-ops", opsDrilldownHandler(audit.sshOpsBreakdown, audit.sshOpsEvents));
app.get("/api/drilldown/download-ops", opsDrilldownHandler(audit.downloadOpsBreakdown, audit.downloadOpsEvents));
app.get("/api/drilldown/docker-ops", opsDrilldownHandler(audit.dockerOpsBreakdown, audit.dockerOpsEvents));
app.get("/api/drilldown/archive-ops", opsDrilldownHandler(audit.archiveOpsBreakdown, audit.archiveOpsEvents));
app.get("/api/drilldown/netdiag-ops", opsDrilldownHandler(audit.netdiagOpsBreakdown, audit.netdiagOpsEvents));
app.get("/api/drilldown/reverseeng-ops", opsDrilldownHandler(audit.reverseEngOpsBreakdown, audit.reverseEngOpsEvents));
app.get("/api/drilldown/procbg-ops", opsDrilldownHandler(audit.procbgOpsBreakdown, audit.procbgOpsEvents));
app.get("/api/drilldown/sensitive-ops", opsDrilldownHandler(audit.sensitiveOpsBreakdown, audit.sensitiveOpsEvents));
app.get("/api/drilldown/sensitive-data", opsDrilldownHandler(audit.sensitiveDataBreakdown, audit.sensitiveDataEvents));
app.get("/api/drilldown/advanced-threat", opsDrilldownHandler(audit.advancedThreatBreakdown, audit.advancedThreatEvents));
app.get("/api/drilldown/workdir-escape", opsDrilldownHandler(audit.workdirEscapeBreakdown, audit.workdirEscapeEvents));

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

app.get("/api/drilldown/screenshot", (req, res) => {
  const rows = audit.screenshotDetails().map((row) => {
    let detail = {};
    try {
      detail = row.detail ? JSON.parse(row.detail) : {};
    } catch (e) {
      detail = {};
    }
    // 只给"基本信息"：命令原文/文件路径这类 fmt.describe() 已经在算的摘要文本，
    // 不读取、不 serve 截图文件本身的图像内容——截图很可能带敏感桌面信息，用户
    // 明确要求详情页只展示路径和基本信息，不展示图内容。
    const { label, summaryHtml } = fmt.describe(row.tool_name, "hook_pre", detail);
    return {
      id: row.id,
      ts: row.ts,
      sessionId: row.session_id,
      cwd: row.cwd,
      toolName: row.tool_name,
      matchedRule: row.matched_rule,
      kind: row.kind,
      label,
      summaryHtml,
    };
  });
  // 带上按方式分类的小计：真截屏（截图工具 / headless 浏览器 / MCP 动作）跟"只是打开
  // 了一张图片"必须分得开，否则整卡数字几乎全是后者，看不出前者有没有被检测到。
  res.json({ breakdown: audit.screenshotBreakdown(), events: rows });
});

app.get("/api/drilldown/tool-calls", (req, res) => {
  res.json({ breakdown: audit.toolCallBreakdown(), events: audit.toolCallEvents() });
});

app.get("/api/drilldown/mcp-calls", (req, res) => {
  res.json({ breakdown: audit.mcpCallBreakdown(), events: audit.mcpCallEvents() });
});

app.get("/api/drilldown/skill-calls", (req, res) => {
  res.json({ breakdown: audit.skillCallBreakdown(), events: audit.skillCallEvents() });
});

app.get("/api/drilldown/subagent-calls", (req, res) => {
  res.json({ breakdown: audit.subagentCallBreakdown(), events: audit.subagentCallEvents() });
});

app.get("/api/drilldown/search-calls", (req, res) => {
  res.json({ breakdown: audit.searchCallBreakdown(), events: audit.searchCallEvents() });
});

app.get("/api/drilldown/todo-calls", (req, res) => {
  res.json(audit.todoCallEvents());
});

app.get("/api/drilldown/ai-trajectory-events", (req, res) => {
  res.json(audit.networkConnectEvents());
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

// ---- REST API: 首页"同步更新"按钮——在项目源码目录里跑 git pull，把 GitHub 上的新
// 代码/新规则同步下来。固定跑 `git pull`，不接受任何请求参数拼进命令行（execFile 不
// 经过 shell，参数是固定数组，没有注入空间）。只是把 git 自己的输出原样返回给前端，
// 不做任何"自动解决冲突"之类的动作——本地有冲突的话 git pull 自己就会失败并说明原因，
// 工作区不会被这个按钮静默改动/丢弃任何东西。拉下来的是源码文件，不会自动重启
// Node 进程/重新执行 Python hook 里已经 import 过的模块，所以前端要提示"可能需要
// 重启 Web UI 才会用上新代码"。
const REPO_ROOT = path.join(__dirname, "..");
app.post("/api/sync-update", (req, res) => {
  execFile("git", ["pull"], { cwd: REPO_ROOT, timeout: 60_000 }, (err, stdout, stderr) => {
    res.json({
      ok: !err,
      code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
      stdout: stdout || "",
      stderr: stderr || (err && !stdout ? String(err.message || err) : ""),
    });
  });
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

app.get("/api/status", async (req, res) => {
  const cwdCache = new Map();
  const liveProcs = await processScan.scanClaudeProcesses();
  const liveCwds = new Set(liveProcs.map((p) => normCwd(p.cwd, cwdCache)).filter(Boolean));
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
      ...(() => {
        const v = vitalStatus(s.alive, s.lastOutputAt);
        return { status: v.status, statusAgoMs: v.agoMs };
      })(),
    };
  });
  const auditSessions = audit.listSessions(50).map((r) => {
    const g = status.gitInfo(r.cwd);
    const tokenStats = r.transcript_path ? transcript.getTokenStats(r.transcript_path) : null;
    const hasLiveProcess = r.cwd ? liveCwds.has(normCwd(r.cwd, cwdCache)) : false;
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
      compactionStats: r.transcript_path ? transcript.getCompactionStats(r.transcript_path) : null,
      ...(() => {
        const v = vitalStatus(hasLiveProcess, r.last_ts);
        return { status: v.status, statusAgoMs: v.agoMs };
      })(),
    };
  });
  res.json({ liveSessions, auditSessions });
});

// 不同模型的使用情况统计——把每个 session 的 transcript 已经按模型分好组的
// token 用量（见 transcript.js 的 getTokenStats().byModel）汇总到一起，
// 不是重新扫一遍文件，是复用 /api/status 已经在算的同一份数据。
app.get("/api/model-usage", (req, res) => {
  const rows = audit.listSessions(200);
  const totals = {};
  for (const r of rows) {
    if (!r.transcript_path) continue;
    const stats = transcript.getTokenStats(r.transcript_path);
    if (!stats || !stats.byModel) continue;
    for (const [model, b] of Object.entries(stats.byModel)) {
      if (!totals[model]) totals[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turns: 0, sessionCount: 0 };
      totals[model].inputTokens += b.inputTokens;
      totals[model].outputTokens += b.outputTokens;
      totals[model].cacheReadTokens += b.cacheReadTokens;
      totals[model].cacheCreationTokens += b.cacheCreationTokens;
      totals[model].turns += b.turns;
      totals[model].sessionCount += 1;
    }
  }
  const models = Object.entries(totals)
    .map(([model, b]) => ({
      model,
      ...b,
      totalTokens: b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  res.json({ models, sessionsScanned: rows.length });
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
  // cc_monitor 那边的 hook（Python）跟这个 Web UI 进程各自独立算自己的 ~/.cc-monitor/
  // 目录——都是当前进程的操作系统用户的 home，不是同一个配置项。如果 Web UI 用
  // root/sudo 启动，但你平时在终端里跑 claude 用的是自己的普通账号，两边写的完全
  // 是两个不相干的 SQLite 文件：终端里的确认框、审计事件，"待批准"页面永远看不到。
  // 这里把当前用户名打出来，不对的话一眼就能看出来，不用等排查半天才发现。
  try {
    const user = os.userInfo().username;
    console.log(
      `[CC-Monitor WebUI] 当前运行用户: ${user}（提醒：必须跟你平时跑 claude 的那个终端是同一个操作系统用户，` +
        `不然两边各写各的 ~/.cc-monitor/ 数据库，互相看不到彼此——不要用 sudo/root 启动这个服务，除非你的 claude 也是用 root 跑的）`
    );
  } catch (e) {
    // os.userInfo() 在极少数环境下可能拿不到（比如缺 uid/gid 映射），拿不到就算了，不影响功能
  }
});
