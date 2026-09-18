"use strict";

// toLocaleTimeString() 不传参数的话是不是 12 小时制（"7:48:25 PM"）取决于浏览器的
// locale 设置，不受这个应用自己的中英文切换控制——不管界面语言选的是中文还是英文，
// 都统一用 24 小时制，不跟着浏览器/系统 locale 飘。
function fmtTime24(date) {
  return date.toLocaleTimeString(undefined, { hour12: false });
}
function fmtDateTime24(date) {
  return date.toLocaleString(undefined, { hour12: false });
}

const RISK_COLOR = { high: "var(--red)", medium: "var(--yellow)", low: "var(--green)", info: "var(--cyan)", "-": "var(--text-dim)" };
const DECISION_COLOR = { blocked: "var(--red)", allowed: "var(--green)", completed: "var(--accent)", observed: "var(--cyan)" };
const KNOWN_TOOLS = new Set([
  "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite",
  "UserPromptSubmit", "SessionStart", "SessionEnd", "PreCompact", "Stop", "SubagentStop",
]);

function decisionLabel(decision) {
  return t("decision." + decision) || decision;
}
function sourceLabel2(source) {
  return t("source." + source) || source;
}
function riskLabel(risk) {
  return t("risk." + risk) || risk;
}
function stageLabel2(source) {
  return t("stage." + source) || source;
}
// 工具名（Bash/Write/...）能翻译就翻译；系统层观测事件、未知/自定义工具这些服务端
// 拼出来的复合文案暂时保留原样（中文兜底），不是每一条都做了双语。
function toolLabel(toolName, serverLabel) {
  return KNOWN_TOOLS.has(toolName) ? t("tool." + toolName) : serverLabel;
}
const EXTRA_LABEL_MAP = { 结果: "extra.result", 输出: "extra.output", 自定义压缩指令: "extra.compactInstructions" };
function translateExtraLabel(label) {
  return EXTRA_LABEL_MAP[label] ? t(EXTRA_LABEL_MAP[label]) : label;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatUptime(ms) {
  const mins = Math.floor(ms / 60000);
  return mins < 1 ? t("terminal.justNow") : t("terminal.minutesAgo", { n: mins });
}

// "最近活跃"用的措辞跟 formatUptime()（"运行了 N 分钟"）不是一回事——这里要的是
// "上次有动静是 N 分钟/小时/天前"，末尾得带"前"/"ago"，不能共用同一个 i18n key。
// 会话经常一放就是几百分钟甚至好几天没再动过，只用分钟计数的话数字会大到没意义
// （"3887 分钟前"），超过 60 分钟换算成小时、超过 24 小时换算成天。
function formatAgo(ms) {
  if (ms === null || ms === undefined) return "-";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return t("terminal.justNow");
  if (mins < 60) return t("drilldown.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("drilldown.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  return t("drilldown.daysAgo", { n: days });
}

// 时长（秒）→ "7 天 12 小时" / "3 小时 42 分钟"。跟 formatAgo 的区别是它描述的是一段
// 持续时间，不是"多久以前"，所以不带"前"字。
function formatDuration(sec) {
  if (sec === null || sec === undefined) return "-";
  if (sec < 60) return t("drilldown.duration.seconds", { s: Math.floor(sec) });
  const mins = Math.floor(sec / 60);
  if (mins < 60) return t("drilldown.duration.minutes", { m: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("drilldown.duration.hours", { h: hours, m: mins % 60 });
  return t("drilldown.duration.days", { d: Math.floor(hours / 24), h: hours % 24 });
}

// "生命体征"指示器：working/idle/dead 三态复用同一套心电监护仪视觉——见 style.css
// 顶部那段注释。心形和锯齿波形都是通用图形符号，不是照抄哪个具体图标库的资源。
const VITAL_HEART_PATH =
  "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z";
const VITAL_ECG_PATH = "M0,7 L11,7 L14,1 L18,13 L21,7 L26,7 L29,3 L32,11 L35,7 L40,7";
const VITAL_ECG_FLAT_PATH = "M0,7 L40,7";
const VITAL_FADE_MS = 60 * 60 * 1000; // 1 小时内颜色/波形连续衰减
const VITAL_WORKING_MS = 5 * 60 * 1000; // 只有这个窗口内才有跳动/滚动动画，跟后端 WORKING_THRESHOLD_MS 对齐
// idle（进程还活着，只是最近没动静）哪怕过了 1 小时的衰减窗口也留一点底色——
// 不然长时间挂着没操作的会话跟"进程已经退出"的 dead 在视觉上就完全混成一回事了，
// 等于白做这个区分"还活着但闲置"和"已经不在了"的功能（真实会话经常一放就是
// 几百分钟甚至几天，绝大多数行都会落进这个区间）。dead 没有这个底色，就是纯灰。
const VITAL_IDLE_FLOOR = 0.14;

// heat：0~1，agoMs 越小越接近 1（最深红/摆动最大），working/idle 状态下随时间
// 在 1 小时内线性衰减；idle 衰减到底之后停在 VITAL_IDLE_FLOOR，不会跟 dead 一样
// 归零。dead 或者压根没有时间戳的（不知道多久没动过了）直接按 0 处理。
function vitalHeat(status, agoMs) {
  if (status === "dead" || agoMs === null || agoMs === undefined) return 0;
  const raw = Math.max(0, 1 - agoMs / VITAL_FADE_MS);
  return status === "idle" ? Math.max(raw, VITAL_IDLE_FLOOR) : raw;
}

function hexToRgb(hex) {
  const m = String(hex || "").trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// 之前按 heat 在红色/灰色之间插值是交给 CSS 的 color-mix() 做的——在不支持
// color-mix() 的浏览器上这个属性整体计算失败，working/idle/dead 三态会退化成
// 同一种继承色（看起来"全灰"，包括刚活跃的 working 也不例外，这正是这个 bug
// 反馈的现象）。干脆不依赖 color-mix()，直接在 JS 里读主题色手算插值后的
// rgb()，兼容性只取决于 getComputedStyle，不受这个较新 CSS 函数支不支持影响。
function vitalColor(heat) {
  const cs = getComputedStyle(document.documentElement);
  const red = hexToRgb(cs.getPropertyValue("--red")) || [239, 68, 68];
  const dim = hexToRgb(cs.getPropertyValue("--text-dim")) || [122, 128, 148];
  const r = Math.round(dim[0] + (red[0] - dim[0]) * heat);
  const g = Math.round(dim[1] + (red[1] - dim[1]) * heat);
  const b = Math.round(dim[2] + (red[2] - dim[2]) * heat);
  return `rgb(${r}, ${g}, ${b})`;
}

function renderVital(status, agoMs) {
  const s = status || "idle";
  const label = t("terminal.status." + s);
  const heat = vitalHeat(s, agoMs);
  // 心电图是否拉直线看的是真实经过的时间（满 1 小时就拉直），跟上面带了个底色
  // 的 heat 是两码事——不能用 heat<=0.02 判断了，idle 有底色之后 heat 永远不会
  // 真的到 0，得直接看 agoMs。
  const flat = s === "dead" || agoMs === null || agoMs === undefined || agoMs >= VITAL_FADE_MS;
  const animated = s === "working" && agoMs !== null && agoMs !== undefined && agoMs < VITAL_WORKING_MS;
  const cls = ["vital", `vital-${s}`, animated ? "vital-animated" : "", flat ? "vital-flat" : ""].filter(Boolean).join(" ");
  const style = `--vital-heat:${heat.toFixed(2)};--vital-color:${vitalColor(heat)}`;
  return `
    <span class="${cls}" style="${style}" title="${escapeHtml(label)}">
      <svg class="vital-heart" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${VITAL_HEART_PATH}"/></svg>
      <svg class="vital-ecg" viewBox="0 0 40 14" aria-hidden="true"><path d="${flat ? VITAL_ECG_FLAT_PATH : VITAL_ECG_PATH}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>
    </span>`;
}

// ---------- 错误提示条：网络/接口失败时给出可见反馈，而不是静默不动 ----------
const errorBanner = document.getElementById("error-banner");
let errorHideTimer = null;
function showError(message) {
  errorBanner.textContent = "";
  const span = document.createElement("span");
  span.textContent = "⚠ " + message;
  const btn = document.createElement("button");
  btn.textContent = t("error.ack");
  btn.addEventListener("click", hideError);
  errorBanner.appendChild(span);
  errorBanner.appendChild(btn);
  errorBanner.hidden = false;
  clearTimeout(errorHideTimer);
  errorHideTimer = setTimeout(hideError, 8000);
}
function hideError() {
  errorBanner.hidden = true;
  clearTimeout(errorHideTimer);
}

// ---------- 多 agent：顶栏过滤器 ----------
// 选了某家 agent 之后，所有 GET /api/* 请求自动带上 agent=<id>；后端认这个参数的接口
// （/api/logs、/api/log-sessions）就只返回那一家的记录，不认的接口忽略它。存在 localStorage
// 里，刷新页面不丢。
const AGENT_FILTER_KEY = "cc-monitor-agent-filter";
const agentFilterSelect = document.getElementById("agent-filter");
let agentFilter = "";
try {
  agentFilter = localStorage.getItem(AGENT_FILTER_KEY) || "";
} catch (e) {
  agentFilter = "";
}
// id → 显示名，来自 /api/agents；拿到之前用 id 本身
const agentNames = new Map();
const agentStatus = new Map(); // id → "verified" | "experimental"
let multiAgent = false; // 库里有不止一家 agent 的记录时才在各处显示徽标
let lastAgentRows = []; // /api/agents 最近一次的结果

function agentDisplay(id) {
  return agentNames.get(id) || id || "";
}

function agentBadge(id, force) {
  if (!id || (!multiAgent && !force)) return "";
  const safe = String(id).replace(/[^a-z0-9_-]/gi, "");
  const exp = agentStatus.get(id) === "experimental";
  const title = exp ? `${id} · ${t("agents.experimental.title")}` : id;
  return `<span class="agent-badge agent-${safe}${exp ? " agent-experimental" : ""}" title="${escapeHtml(title)}">${escapeHtml(agentDisplay(id))}${exp ? "<sup>β</sup>" : ""}</span>`;
}

function withAgentParam(path) {
  if (!agentFilter || !path.startsWith("/api/")) return path;
  const [base, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  if (!params.has("agent")) params.set("agent", agentFilter);
  return base + "?" + params.toString();
}

async function api(path, opts) {
  let res;
  try {
    res = await fetch(!opts || !opts.method || opts.method === "GET" ? withAgentParam(path) : path, opts);
  } catch (e) {
    showError(t("error.fetchFailed", { msg: e.message }));
    return null;
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error || "";
    } catch (e) {
      // ignore
    }
    showError(t("error.requestFailed", { status: res.status, path, detail: detail ? "：" + detail : "" }));
    return null;
  }
  return res.json();
}

// ---------- 通用确认弹窗（替代 window.confirm，风格跟页面一致） ----------
const confirmModal = document.getElementById("confirm-modal");
function confirmDialog(title, body) {
  return new Promise((resolve) => {
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-body").textContent = body;
    confirmModal.hidden = false;
    const okBtn = document.getElementById("confirm-ok");
    const cancelBtn = document.getElementById("confirm-cancel");
    const cleanup = (result) => {
      confirmModal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// ---------- 顶部导航 / 页面切换 ----------
document.querySelectorAll(".tab-btn:not(.nav-external-link)").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn:not(.nav-external-link)").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("view-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "terminal") {
      setTimeout(() => {
        fitAddon.fit();
        for (const pane of gridPanes.values()) pane.fitAddon.fit();
      }, 30);
    }
    // 深链接：地址栏 #logs / #approvals 这类 hash 跟着标签走，刷新或分享链接能直接落到那一页
    if (history.replaceState) history.replaceState(null, "", "#" + btn.dataset.tab);
    if (btn.dataset.tab === "archives") refreshArchivesList();
    if (btn.dataset.tab === "approvals") {
      syncApprovalsNotifyBtn();
      refreshApprovalHistory();
    }
    if (btn.dataset.tab === "network") {
      // WebGL 画布只有在容器真正可见（.view.active，非 display:none）之后
      // getBoundingClientRect() 才能量出正确尺寸，所以地图实例延到第一次真正
      // 切进这个 tab 时才创建，创建完立刻按当前数据刷新一次。
      ensureNetworkMap();
      refreshNetworkTraffic();
    }
  });
});

// ---------- 终端渲染：优先 WebGL(GPU)，失败自动退化成默认的 Canvas 渲染 ----------
const term = new Terminal({
  fontFamily: "Menlo, Consolas, 'Courier New', monospace",
  fontSize: 13,
  cursorBlink: true,
  theme: { background: "#000000", foreground: "#d8dce6" },
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById("terminal"));

const gpuPill = document.getElementById("gpu-status");
let gpuState = "detecting"; // 语言切换时要能重新套用当前状态对应的文案
function setGpuState(state) {
  gpuState = state;
  const map = { detecting: "gpu.detecting", webgl: "gpu.webgl", canvasNoWebgl: "gpu.canvasNoWebgl", canvasLost: "gpu.canvasLost" };
  gpuPill.textContent = t(map[state]);
  gpuPill.className = "pill" + (state === "webgl" ? " gpu" : state === "detecting" ? "" : " cpu");
}
function tryEnableWebgl() {
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      setGpuState("canvasLost");
    });
    term.loadAddon(webgl);
    setGpuState("webgl");
  } catch (e) {
    setGpuState("canvasNoWebgl");
  }
}
tryEnableWebgl();
fitAddon.fit();
window.addEventListener("resize", () => {
  fitAddon.fit();
  for (const pane of gridPanes.values()) pane.fitAddon.fit();
});

// ---------- 会话管理（终端会话页） ----------
let currentSessionId = null;
let currentSocket = null;

// 刷新网页只是重新加载了这个 JS 运行时，PTY 会话本身在服务端还活得好好的——但
// currentSessionId 是个普通变量，刷新一次就归零，界面上看起来就跟"会话没了"一样，
// 得手动去侧边栏重新点一下。存一份到 localStorage，刷新后自动重连回刚才那个会话。
const LAST_SESSION_KEY = "cc-monitor-last-session-id";
function rememberLastSession(id) {
  try {
    if (id) localStorage.setItem(LAST_SESSION_KEY, id);
    else localStorage.removeItem(LAST_SESSION_KEY);
  } catch (e) {
    // localStorage 不可用（隐私模式等）不影响功能，只是刷新后不会自动重连
  }
}
function getLastSession() {
  try {
    return localStorage.getItem(LAST_SESSION_KEY);
  } catch (e) {
    return null;
  }
}

async function refreshSessionList() {
  const sessions = await api("/api/sessions");
  if (!sessions) return [];
  syncGridPanes(sessions);
  const list = document.getElementById("session-list");
  list.innerHTML = "";
  if (sessions.length === 0) {
    list.innerHTML = `<div class="empty-state">${t("terminal.sessionListEmpty")}</div>`;
    return sessions;
  }
  for (const s of sessions) {
    const el = document.createElement("div");
    el.className = "session-item" + (s.id === currentSessionId ? " active" : "") + (s.alive ? "" : " dead");
    const status = s.status || (s.alive ? "idle" : "dead");
    el.innerHTML = `
      <div class="cwd">${s.alive ? `<span class="status-dot status-${status}" title="${escapeHtml(t("terminal.status." + status))}"></span>` : ""}${escapeHtml(s.cwd)}</div>
      <div class="meta">
        <span>${fmtTime24(new Date(s.createdAt))} ${s.alive ? "" : t("terminal.exited")}</span>
        <span class="kill-btn" data-id="${s.id}">${t("terminal.close")}</span>
      </div>`;
    el.addEventListener("click", (ev) => {
      if (ev.target.classList.contains("kill-btn")) return;
      selectSession(s.id);
    });
    el.querySelector(".kill-btn").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const ok = await confirmDialog(t("modal.killSession.title"), t("modal.killSession.body", { cwd: s.cwd }));
      if (!ok) return;
      await api("/api/sessions/" + s.id, { method: "DELETE" });
      if (currentSessionId === s.id) {
        currentSessionId = null;
        rememberLastSession(null);
        term.reset();
        document.getElementById("terminal-empty").style.display = "flex";
        document.getElementById("terminal-statusline").innerHTML = "";
      }
      refreshSessionList();
    });
    list.appendChild(el);
  }
  return sessions;
}

function selectSession(id) {
  currentSessionId = id;
  rememberLastSession(id);
  document.getElementById("terminal-empty").style.display = "none";
  term.reset();
  if (currentSocket) currentSocket.close();

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/terminal?id=${id}`);
  currentSocket = ws;

  ws.addEventListener("open", () => {
    fitAddon.fit();
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "data") term.write(msg.data);
    else if (msg.type === "exit") term.write(`\r\n${t("terminal.sessionEnded", { code: msg.exitCode })}\r\n`);
    else if (msg.type === "error") term.write(`\r\n[${msg.message}]\r\n`);
  });
  ws.addEventListener("close", () => {
    if (currentSocket === ws) showError(t("terminal.connectionLost"));
  });

  refreshSessionList();
  refreshTerminalStatusline();
}

term.onData((data) => {
  if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
    currentSocket.send(JSON.stringify({ type: "input", data }));
  }
});
term.onResize(({ cols, rows }) => {
  if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
    currentSocket.send(JSON.stringify({ type: "resize", cols, rows }));
  }
});

// ---------- 终端网格视图（herdr 风格：一个屏幕同时看/操作多个 agent） ----------
// 跟上面的单会话视图是两套独立的 Terminal 实例 + WebSocket 连接，互不影响；
// 切换视图不会打断另一边正在跑的会话。
const gridPanes = new Map(); // sessionId -> { term, fitAddon, ws, el }
let gridModeEnabled = false;
let activeGridPaneId = null;

function computeGridCols(n) {
  if (n <= 2) return n || 1;
  if (n <= 4) return 2;
  if (n <= 6) return 3;
  return 4;
}

function createGridPane(s) {
  const el = document.createElement("div");
  el.className = "grid-pane";
  el.innerHTML = `
    <div class="grid-pane-header" title="${escapeHtml(s.cwd)}">
      <span class="status-dot status-${s.status || "idle"}" data-role="status-dot" title="${escapeHtml(t("terminal.status." + (s.status || "idle")))}"></span>
      <span class="name">${escapeHtml(folderName(s.cwd))} · ${s.id.slice(0, 8)}…</span>
      <span class="kill-btn">${t("terminal.close")}</span>
    </div>
    <div class="grid-pane-body"></div>
  `;
  const bodyEl = el.querySelector(".grid-pane-body");
  const header = el.querySelector(".grid-pane-header");

  const paneTerm = new Terminal({
    fontFamily: "Menlo, Consolas, 'Courier New', monospace",
    fontSize: 12,
    cursorBlink: true,
    theme: { background: "#000000", foreground: "#d8dce6" },
  });
  const paneFit = new FitAddon.FitAddon();
  paneTerm.loadAddon(paneFit);
  paneTerm.open(bodyEl);
  try {
    // 浏览器对同时存在的 WebGL 上下文数量有上限（通常十几个），网格面板一多
    // 拿不到就直接退化成 xterm.js 默认的 canvas 渲染，不影响功能，只是没那么快。
    paneTerm.loadAddon(new WebglAddon.WebglAddon());
  } catch (e) {
    // ignore，canvas 兜底
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/terminal?id=${s.id}`);
  ws.addEventListener("open", () => {
    paneFit.fit();
    ws.send(JSON.stringify({ type: "resize", cols: paneTerm.cols, rows: paneTerm.rows }));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "data") paneTerm.write(msg.data);
    else if (msg.type === "exit") paneTerm.write(`\r\n${t("terminal.sessionEnded", { code: msg.exitCode })}\r\n`);
    else if (msg.type === "error") paneTerm.write(`\r\n[${msg.message}]\r\n`);
  });
  paneTerm.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
  });
  paneTerm.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
  });

  const focusPane = () => {
    for (const p of gridPanes.values()) p.el.classList.remove("active");
    el.classList.add("active");
    activeGridPaneId = s.id;
    paneTerm.focus();
  };
  header.addEventListener("click", focusPane);
  bodyEl.addEventListener("mousedown", focusPane);

  header.querySelector(".kill-btn").addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const ok = await confirmDialog(t("modal.killSession.title"), t("modal.killSession.body", { cwd: s.cwd }));
    if (!ok) return;
    await api("/api/sessions/" + s.id, { method: "DELETE" });
    refreshSessionList();
  });

  return { term: paneTerm, fitAddon: paneFit, ws, el, focusPane };
}

function destroyGridPane(pane) {
  try {
    pane.ws.close();
  } catch (e) {
    // ignore
  }
  try {
    pane.term.dispose();
  } catch (e) {
    // ignore
  }
  pane.el.remove();
}

function syncGridPanes(sessions) {
  if (!gridModeEnabled) return;
  const grid = document.getElementById("terminal-grid");
  const aliveIds = new Set(sessions.filter((s) => s.alive).map((s) => s.id));

  for (const [id, pane] of gridPanes) {
    if (!aliveIds.has(id)) {
      destroyGridPane(pane);
      gridPanes.delete(id);
      if (activeGridPaneId === id) activeGridPaneId = null;
    }
  }

  if (grid.querySelector(".grid-empty")) grid.innerHTML = "";

  let firstNew = null;
  for (const s of sessions) {
    if (s.alive && !gridPanes.has(s.id)) {
      const pane = createGridPane(s);
      gridPanes.set(s.id, pane);
      grid.appendChild(pane.el);
      if (!firstNew) firstNew = pane;
    } else if (s.alive && gridPanes.has(s.id)) {
      // 已经存在的面板不用重建，只更新状态点——createGridPane() 只在第一次
      // 出现时跑一遍，后续每次轮询靠这里把 working/blocked/idle 刷新上去。
      const dot = gridPanes.get(s.id).el.querySelector('[data-role="status-dot"]');
      if (dot) {
        const status = s.status || "idle";
        dot.className = "status-dot status-" + status;
        dot.title = t("terminal.status." + status);
      }
    }
  }

  grid.style.setProperty("--grid-cols", computeGridCols(gridPanes.size));
  if (gridPanes.size === 0) {
    grid.innerHTML = `<div class="grid-empty">${t("terminal.gridEmpty")}</div>`;
  } else if (!activeGridPaneId && firstNew) {
    firstNew.focusPane();
  }

  requestAnimationFrame(() => {
    for (const pane of gridPanes.values()) pane.fitAddon.fit();
  });
}

// 这个按钮的文案跟着 gridModeEnabled 这个 state 走，不能用静态的 data-i18n
// （不然切语言的时候会被 applyStaticI18n 冲回"切换到网格视图"，不管当前到底是哪个视图）。
function syncGridToggleBtnText() {
  document.getElementById("grid-toggle-btn").textContent = t(gridModeEnabled ? "terminal.toSingle" : "terminal.toGrid");
}

document.getElementById("grid-toggle-btn").addEventListener("click", async () => {
  gridModeEnabled = !gridModeEnabled;
  const single = document.getElementById("terminal-wrap");
  const statusline = document.getElementById("terminal-statusline");
  const grid = document.getElementById("terminal-grid-pane");
  syncGridToggleBtnText();
  if (gridModeEnabled) {
    single.hidden = true;
    statusline.hidden = true;
    grid.hidden = false;
    syncGridPanes(await refreshSessionList());
  } else {
    single.hidden = false;
    statusline.hidden = false;
    grid.hidden = true;
  }
});

const newSessionModal = document.getElementById("new-session-modal");
const newSessionCwdInput = document.getElementById("new-session-cwd");
const newSessionTitleEl = document.getElementById("new-session-title");
const newSessionHintEl = document.getElementById("new-session-hint");
// "新建会话"（自动敲 claude）和"新建窗口"（裸 shell，不进 Claude Code）共用同一个
// 弹窗——挑目录这一步两边完全一样，没必要做成两个弹窗。靠这个变量记住是哪个按钮
// 打开的，弹窗标题/说明文字跟着换，确认时决定要不要把 launchClaude:false 传给后端。
let newSessionLaunchClaude = true;

// 弹窗标题/说明文字是根据 newSessionLaunchClaude 这个"状态"动态选的，不是纯粹
// 靠 data-i18n 静态属性翻译——切换语言时 applyStaticI18n() 只会把它们打回
// data-i18n 属性里写死的默认文案（新建会话那版），跟 syncGridToggleBtnText() 这些
// 处理"状态相关文案"的函数是同一个道理，得在语言切换后单独重新套一遍当前状态对应的文案。
function syncNewSessionModalText() {
  if (newSessionModal.hidden) return;
  newSessionTitleEl.textContent = newSessionLaunchClaude ? t("modal.newSession.title") : t("modal.newWindow.title");
  newSessionHintEl.innerHTML = newSessionLaunchClaude ? t("modal.newSession.hint") : t("modal.newWindow.hint");
}
const newSessionAgentSelect = document.getElementById("new-session-agent");
const newSessionAgentRow = document.getElementById("new-session-agent-row");
// 下拉框里列本机装了、且有启动命令的 agent（/api/agents 的 installed 字段）；只有 Claude Code
// 一家时整行藏起来，弹窗跟以前一样。
function syncNewSessionAgentOptions() {
  const rows = (lastAgentRows || []).filter((a) => a.launchCommand && (a.installed || a.id === "claude-code"));
  newSessionAgentSelect.innerHTML = "";
  for (const a of rows) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.display;
    newSessionAgentSelect.appendChild(opt);
  }
  newSessionAgentSelect.value = rows.some((a) => a.id === agentFilter) ? agentFilter : "claude-code";
  newSessionAgentRow.hidden = rows.length <= 1 || !newSessionLaunchClaude;
}
function openNewSessionModal(launchClaude) {
  newSessionLaunchClaude = launchClaude;
  newSessionCwdInput.value = "";
  syncNewSessionAgentOptions();
  newSessionModal.hidden = false;
  syncNewSessionModalText();
  newSessionCwdInput.focus();
}
document.getElementById("new-session-btn").addEventListener("click", () => openNewSessionModal(true));
document.getElementById("new-window-btn").addEventListener("click", () => openNewSessionModal(false));
document.getElementById("new-session-cancel").addEventListener("click", () => {
  newSessionModal.hidden = true;
});
newSessionModal.addEventListener("click", (ev) => {
  if (ev.target === newSessionModal) newSessionModal.hidden = true; // 点击背景关闭
});
async function createSessionFromModal() {
  const cwd = newSessionCwdInput.value.trim();
  const launchClaude = newSessionLaunchClaude;
  newSessionModal.hidden = true;
  const session = await api("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: cwd || undefined, launchClaude, agent: newSessionAgentSelect.value || "claude-code" }),
  });
  if (!session) return;
  await refreshSessionList();
  selectSession(session.id);
}
document.getElementById("new-session-confirm").addEventListener("click", createSessionFromModal);
newSessionCwdInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") createSessionFromModal();
});

// ---------- "新建会话"弹窗里的文件夹浏览器：选服务器上的目录，不是浏览器本机的 ----------
// 这个终端是在跑 webui 的那台机器上开 shell，能选的目录得是那台机器上的路径；
// 用原生 <input type=file webkitdirectory> 选到的是打开浏览器那台机器的文件——
// 如果是远程访问这个 Web UI，两边根本不是同一台机器，选出来的路径没有意义，
// 所以这里是自己做的一个服务端目录浏览接口 + 简单列表 UI，不是调用浏览器原生控件。
const dirBrowserModal = document.getElementById("dir-browser-modal");
const dirBrowserPathEl = document.getElementById("dir-browser-path");
const dirBrowserListEl = document.getElementById("dir-browser-list");
let dirBrowserCurrentPath = "";

async function loadDirBrowser(targetPath) {
  const result = await api("/api/browse-dir?path=" + encodeURIComponent(targetPath || ""));
  if (!result) return;
  dirBrowserCurrentPath = result.path;
  dirBrowserPathEl.textContent = result.path;
  const rows = [];
  if (result.parent) {
    rows.push(`<div class="dir-browser-item dir-browser-up" data-path="${escapeHtml(result.parent)}">⬆ ..</div>`);
  }
  for (const name of result.dirs) {
    const full = result.path.replace(/\/$/, "") + "/" + name;
    rows.push(`<div class="dir-browser-item" data-path="${escapeHtml(full)}">📁 ${escapeHtml(name)}</div>`);
  }
  dirBrowserListEl.innerHTML = rows.length
    ? rows.join("")
    : `<div class="empty-state">${t("modal.dirBrowser.empty")}</div>`;
  dirBrowserListEl.querySelectorAll(".dir-browser-item").forEach((el) => {
    el.addEventListener("click", () => loadDirBrowser(el.dataset.path));
  });
}
document.getElementById("new-session-browse-btn").addEventListener("click", () => {
  dirBrowserModal.hidden = false;
  loadDirBrowser(newSessionCwdInput.value.trim());
});
document.getElementById("dir-browser-close").addEventListener("click", () => (dirBrowserModal.hidden = true));
document.getElementById("dir-browser-cancel").addEventListener("click", () => (dirBrowserModal.hidden = true));
document.getElementById("dir-browser-select").addEventListener("click", () => {
  newSessionCwdInput.value = dirBrowserCurrentPath;
  dirBrowserModal.hidden = true;
});
dirBrowserModal.addEventListener("click", (ev) => {
  if (ev.target === dirBrowserModal) dirBrowserModal.hidden = true;
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (!newSessionModal.hidden) newSessionModal.hidden = true;
  if (!dirBrowserModal.hidden) dirBrowserModal.hidden = true;
  if (!confirmModal.hidden) document.getElementById("confirm-cancel").click();
  if (!drilldownModal.hidden) drilldownModal.hidden = true;
});

// 当前选中会话上方的状态条（cwd / git 分支 / 存活时长），来自 /api/status。
async function refreshTerminalStatusline() {
  if (!currentSessionId) return;
  const status = await api("/api/status");
  if (!status) return;
  const s = status.liveSessions.find((x) => x.id === currentSessionId);
  const el = document.getElementById("terminal-statusline");
  if (!s) {
    el.innerHTML = "";
    return;
  }
  const mins = Math.floor(s.uptimeMs / 60000);
  el.innerHTML = `
    <span class="seg ${s.alive ? "alive" : "dead"}">${s.alive ? t("terminal.running") : t("terminal.stopped")}</span>
    <span class="seg cwd">📁 ${escapeHtml(s.cwd)}</span>
    ${s.gitBranch ? `<span class="seg branch${s.gitDirty ? " dirty" : ""}">⎇ ${escapeHtml(s.gitBranch)}</span>` : ""}
    <span class="seg">⏱ ${mins < 1 ? t("terminal.justNow") : t("terminal.minutesAgo", { n: mins })}</span>
  `;
}

// ---------- Log 审计页 ----------
let lastLogId = 0;
const logFilter = document.getElementById("log-session-filter");

// 只看 session id 完全没法识别是哪个会话——同一屏幕上好几个 8 位十六进制字符串
// 长得都差不多。前面加上文件夹名（cwd 最后一段）和模型短名，才是人真正会用来
// 区分"这是哪个会话"的信息；完整 cwd 和完整 id 放 title，鼠标悬停可以看到。
function folderName(cwd) {
  if (!cwd) return "(未知目录)";
  const parts = cwd.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}
// Session ID 前面带上文件夹名——光看一串截断的 UUID 认不出是哪个会话，folderName(cwd)
// 一般比 session_id 好记得多，两个拼一起显示（表格窄了的话完整 cwd 还有单独一列/title）
function sessionIdCell(sessionId, cwd) {
  const idPart = sessionId ? escapeHtml(sessionId.slice(0, 8)) + "…" : "-";
  if (!cwd) return idPart;
  return `${escapeHtml(folderName(cwd))} · ${idPart}`;
}
function modelShort(model) {
  if (!model) return "";
  return model.replace(/^claude-/, "");
}
function sessionLabel(r) {
  const folder = folderName(r.cwd);
  const model = modelShort(r.model);
  const shortId = r.session_id.slice(0, 8);
  return `${folder}${model ? " · " + model : ""} · ${shortId}… (${r.event_count})`;
}

async function refreshLogSessionOptions() {
  const rows = await api("/api/log-sessions");
  if (!rows) return [];
  // 重建 <select> 的 <option> 列表在原生下拉框还开着的时候会把它关掉（哪怕内容没变）——
  // 用户正在这个下拉框上（focus 在它身上，不管下拉是不是真的展开着）就先跳过这次重建，
  // 免得手一伸过去选项就被刷没了；反正 8 秒后还会再刷一次，晚一点更新没关系。
  if (document.activeElement !== logFilter) {
    const current = logFilter.value;
    logFilter.innerHTML = `<option value="">${t("logs.allSessions")}</option>`;
    for (const r of rows) {
      const opt = document.createElement("option");
      opt.value = r.session_id;
      const flag = r.bypass_count > 0 ? " ⚠" : r.blocked_count > 0 ? " 🛑" : "";
      const agentTag = multiAgent && r.agent ? "[" + agentDisplay(r.agent) + "] " : "";
      opt.textContent = agentTag + sessionLabel(r) + flag;
      opt.title = `${r.cwd || ""}\nID: ${r.session_id}`;
      logFilter.appendChild(opt);
    }
    logFilter.value = current;
  }
  refreshTapSessionOptions(rows);
  return rows;
}

logFilter.addEventListener("change", () => {
  lastLogId = 0;
  document.getElementById("log-list-full").innerHTML = "";
  pollLogs();
});

// 自动滚动到最新的开关：关掉之后新内容还是会照常拼进列表（不影响记录/实时刷新），
// 只是不再把滚动条拽到底部，方便往上翻看历史内容时不被每次轮询打断。开关状态记在
// localStorage 里，跟语言/主题一个存法。Log 审计和 AI Tap 各有一个独立开关。
function setupAutoscrollToggle(elementId, storageKey) {
  const el = document.getElementById(elementId);
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) el.checked = saved === "1";
  } catch (e) {
    // localStorage 不可用（隐私模式等）就用默认值，不影响功能
  }
  el.addEventListener("change", () => {
    try {
      localStorage.setItem(storageKey, el.checked ? "1" : "0");
    } catch (e) {
      // ignore
    }
  });
  return el;
}
const logAutoscrollToggle = setupAutoscrollToggle("log-autoscroll-toggle", "cc_monitor_log_autoscroll");
const tapAutoscrollToggle = setupAutoscrollToggle("tap-autoscroll-toggle", "cc_monitor_tap_autoscroll");

// "显示思考详情"开关：关（默认）时 .tap-thinking 只露出前几行、超出部分用 CSS 折叠；
// 开的时候展开全部。后端现在本来就把完整思考内容发下来了（不是按开关状态单独请求），
// 这里纯粹是前端 CSS 折叠/展开，切换瞬间生效，不用重新拉数据。
const tapThinkingDetailToggle = setupAutoscrollToggle("tap-thinking-detail-toggle", "cc_monitor_tap_thinking_detail");
function applyThinkingDetailClass() {
  document.getElementById("tap-list").classList.toggle("show-thinking-detail", tapThinkingDetailToggle.checked);
}
tapThinkingDetailToggle.addEventListener("change", applyThinkingDetailClass);
applyThinkingDetailClass();

// 操作分类：读/写/编辑/执行/删除，用来给徽章挑颜色。删除没有专门的工具，
// 跟首页文件操作统计用一样的近似识别方式——Bash 命令文本里带 rm/unlink/rmdir/shred。
function operationCategory(ev) {
  if (ev.toolName === "Read") return "read";
  if (ev.toolName === "Write") return "write";
  if (["Edit", "MultiEdit", "NotebookEdit"].includes(ev.toolName)) return "edit";
  if (ev.toolName === "Bash") {
    const text = (ev.summaryHtml || "") + (ev.matchedRule || "");
    if (/dangerous_delete|\brm\b|\bunlink\b|\brmdir\b|\bshred\b/i.test(text)) return "delete";
    return "bash";
  }
  return "other";
}

function renderLogItem(ev) {
  const el = document.createElement("div");
  const opCategory = operationCategory(ev);
  el.className = "log-item" + (ev.risk === "high" ? " risk-high" : "");
  const extraHtml = (ev.extra || [])
    .map((e) => `<div class="extra">${e.label ? `<span class="lbl">${escapeHtml(translateExtraLabel(e.label))}: </span>` : ""}${e.html}</div>`)
    .join("");
  el.innerHTML = `
    <div class="row1">
      <span class="ts">${ev.ts}</span>
      <span class="risk ${ev.risk}">${escapeHtml(riskLabel(ev.risk))}</span>
      ${agentBadge(ev.agent)}
      <span class="label op-${opCategory}"${ev.nativeTool ? ` title="${escapeHtml(ev.nativeTool)}"` : ""}>${escapeHtml(toolLabel(ev.toolName, ev.label))}</span>
      <span class="decision ${ev.decision}">${escapeHtml(decisionLabel(ev.decision))}</span>
      <span class="session-tag">${ev.sessionId ? "📁 " + escapeHtml(folderName(ev.cwd)) + " · " + ev.sessionId.slice(0, 8) + "…" : ""}</span>
    </div>
    <div class="cwd">${escapeHtml(ev.cwd || "")}</div>
    <div class="summary">${ev.summaryHtml || ""}</div>
    ${extraHtml}
  `;
  return el;
}

async function pollLogs() {
  const params = new URLSearchParams({ since_id: String(lastLogId), limit: "300" });
  if (logFilter.value) params.set("session_id", logFilter.value);
  const result = await api("/api/logs?" + params.toString());
  if (!result) return;
  const list = document.getElementById("log-list-full");
  if (result.events.length === 0 && list.children.length === 0) {
    list.innerHTML = `<div class="empty-state">${t("logs.empty")}</div>`;
    return;
  }
  if (list.querySelector(".empty-state")) list.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const ev of result.events) {
    lastLogId = Math.max(lastLogId, ev.id);
    frag.appendChild(renderLogItem(ev));
  }
  list.appendChild(frag);
  while (list.children.length > 500) list.removeChild(list.firstChild);
  if (logAutoscrollToggle.checked) list.scrollTop = list.scrollHeight;
}

// ---------- AI Tap：发给/收到模型的完整对话内容 ----------
const tapSelect = document.getElementById("tap-session-select");
const tapMeta = document.getElementById("tap-meta");
const TAP_ALL_SESSIONS = "__all__";
let tapNextLine = 0;
let tapKnownSessions = [];

// 跟终端会话那个"刷新页面就要重新选"是同一类问题：tapSelect.value 只是个 DOM 状态，
// 刷新页面这个下拉框直接重新创建，之前选的会话就没了。存一份到 localStorage，
// 下拉框第一次建好选项时（这次页面加载还没选过任何东西）就把上次选的那个带回来。
const TAP_LAST_SESSION_KEY = "cc-monitor-last-tap-session";
function rememberTapSession(id) {
  try {
    if (id) localStorage.setItem(TAP_LAST_SESSION_KEY, id);
    else localStorage.removeItem(TAP_LAST_SESSION_KEY);
  } catch (e) {
    // localStorage 不可用不影响功能，只是刷新后不会自动带回来
  }
}
function getLastTapSession() {
  try {
    return localStorage.getItem(TAP_LAST_SESSION_KEY);
  } catch (e) {
    return null;
  }
}

let tapOptionsBuiltOnce = false;
function refreshTapSessionOptions(rows) {
  tapKnownSessions = rows;
  // 同样的道理：下拉框正被用户操作（focus 在它上面）的时候不要重建 <option>，
  // 不然选项会在他们眼皮底下被"刷新掉"——这正是这个开关要修的那个 bug。
  if (document.activeElement === tapSelect) return;
  // 不能拿 tapSelect.options.length === 0 判断"是不是第一次"——HTML 里本来就写死了
  // 一个占位 <option>，这个条件永远为 false，得自己记一个标志位。
  const isFirstBuild = !tapOptionsBuiltOnce;
  tapOptionsBuiltOnce = true;
  const current = tapSelect.value;
  tapSelect.innerHTML = `<option value="">${t("tap.selectPlaceholder")}</option>`;
  const hasAnyTranscript = rows.some((r) => r.has_transcript);
  if (hasAnyTranscript) {
    const allOpt = document.createElement("option");
    allOpt.value = TAP_ALL_SESSIONS;
    allOpt.textContent = t("tap.allSessions");
    tapSelect.appendChild(allOpt);
  }
  for (const r of rows) {
    const opt = document.createElement("option");
    opt.value = r.session_id;
    opt.textContent = sessionLabel(r) + (r.has_transcript ? "" : t("tap.noTranscript"));
    opt.disabled = !r.has_transcript;
    opt.title = `${r.cwd || ""}\nID: ${r.session_id}`;
    tapSelect.appendChild(opt);
  }
  const restoreTarget = current || (isFirstBuild ? getLastTapSession() : null);
  if (restoreTarget && (restoreTarget === TAP_ALL_SESSIONS || rows.some((r) => r.session_id === restoreTarget && r.has_transcript))) {
    tapSelect.value = restoreTarget;
    // 是这次页面加载第一次带回来的（不是用户刚选的），程序设值不会触发 change 事件，
    // 得自己手动拉一下数据，不然下拉框显示对了但内容是空的。
    if (!current) pollTap();
  }
  showTapPlaceholder();
}

// 还没选会话时列表是空的——给一句提示，不然整页空白像是坏了。
function showTapPlaceholder() {
  const list = document.getElementById("tap-list");
  if (!tapSelect.value && list.children.length === 0) {
    list.innerHTML = `<div class="empty-state">${t("tap.pickSession")}</div>`;
  }
}

tapSelect.addEventListener("change", () => {
  tapNextLine = 0;
  document.getElementById("tap-list").innerHTML = "";
  tapMeta.textContent = "";
  rememberTapSession(tapSelect.value || null);
  if (tapSelect.value) pollTap();
  else showTapPlaceholder();
});

function renderTapEntry(entry) {
  const el = document.createElement("div");
  el.className = "tap-entry tap-kind-" + entry.kind;
  const ts = entry.ts ? fmtTime24(new Date(entry.ts)) : "";
  // "全部会话"合并视图下每条都带 sessionId，需要标出是哪个会话的，
  // 单会话视图（entry.sessionId 不存在）不显示这个标签。
  const sessionTag = entry.sessionId
    ? `<span class="tap-session-tag">📁 ${escapeHtml(folderName(entry.cwd))}${entry.model ? " · " + escapeHtml(modelShort(entry.model)) : ""} · ${escapeHtml(entry.sessionId.slice(0, 8))}…</span>`
    : "";
  // "Claude" 这个角色名只对 Claude Code 成立；其它 agent 的助手消息用它的显示名
  const roleLabel = entry.kind === "assistant" && entry.agent && entry.agent !== "claude-code"
    ? agentDisplay(entry.agent)
    : t("tap.kind." + entry.kind);
  el.innerHTML = `
    <div class="tap-header">
      <span class="tap-role tap-role-${entry.kind}">${escapeHtml(roleLabel)}</span>${entry.agent && multiAgent ? " " + agentBadge(entry.agent) : ""}
      <span class="tap-ts">${ts}</span>
      ${sessionTag}
      ${entry.usageHtml || ""}
    </div>
    ${entry.blocksHtml || ""}
  `;
  return el;
}

async function pollTap() {
  const sessionId = tapSelect.value;
  if (!sessionId) return;
  const list = document.getElementById("tap-list");

  if (sessionId === TAP_ALL_SESSIONS) {
    // "全部会话"合并视图：每个 session 各取最近一小段、按时间戳合并，不用增量游标
    // （session 数量对个人工具来说通常不多，每次全量重拉比维护多文件游标简单得多）。
    const result = await api("/api/transcript/all?limit=200&per_session_limit=30");
    if (!result) return;
    tapMeta.textContent = t("tap.allSessionsMeta", { n: result.sessionCount });
    tapMeta.title = "";
    if (result.entries.length === 0) {
      list.innerHTML = `<div class="empty-state">${t("tap.loading")}</div>`;
      return;
    }
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const entry of result.entries) frag.appendChild(renderTapEntry(entry));
    list.appendChild(frag);
    if (tapAutoscrollToggle.checked) list.scrollTop = 0;
    return;
  }

  const params = new URLSearchParams({ session_id: sessionId, since_line: String(tapNextLine), limit: "300" });
  const result = await api("/api/transcript?" + params.toString());
  if (!result) return;
  tapNextLine = result.nextLine;
  if (!result.transcriptPath) {
    list.innerHTML = `<div class="empty-state">${t("tap.noTranscriptBody")}</div>`;
    return;
  }
  if (result.missing) {
    // hook payload 里报过这个路径，但文件实际不存在——常见于一次性工具调用/
    // 后台任务这类没有落盘常规 project transcript 的执行上下文，不是卡住了。
    tapMeta.textContent = result.transcriptPath;
    tapMeta.title = result.transcriptPath;
    list.innerHTML = `<div class="empty-state">${t("tap.transcriptMissing")}</div>`;
    return;
  }
  tapMeta.textContent = `${result.totalLines} · ${result.transcriptPath}`;
  tapMeta.title = result.transcriptPath;
  if (result.entries.length === 0 && list.children.length === 0) {
    list.innerHTML = `<div class="empty-state">${t("tap.loading")}</div>`;
    return;
  }
  if (list.querySelector(".empty-state")) list.innerHTML = "";
  // 最新的放最上面、老的往下沉——接口返回的 entries 是按时间正序（旧→新）来的，
  // 要反过来插：本批次内部先倒序拼进 fragment，再整个塞到列表最前面，这样批次内
  // 最新的那条会落在最上面，且跟上一批已经在顶部的更早内容衔接顺序不乱。
  const frag = document.createDocumentFragment();
  for (const entry of result.entries.slice().reverse()) frag.appendChild(renderTapEntry(entry));
  list.insertBefore(frag, list.firstChild);
  while (list.children.length > 400) list.removeChild(list.lastChild);
  if (tapAutoscrollToggle.checked) list.scrollTop = 0;
}

// ---------- 多 agent：/api/agents → 顶栏过滤器 + 首页"被监测的 AI agent"卡 ----------
async function refreshAgents() {
  const rows = await fetch("/api/agents").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!rows) return;
  lastAgentRows = rows;
  for (const a of rows) {
    agentNames.set(a.id, a.display);
    agentStatus.set(a.id, a.status || "experimental");
  }
  const active = rows.filter((a) => a.events > 0);
  multiAgent = active.length > 1;

  // 顶栏过滤器：只列有记录的 agent；只有一家时整个下拉框藏起来（界面跟以前一样）
  if (document.activeElement !== agentFilterSelect) {
    const current = agentFilterSelect.value;
    agentFilterSelect.innerHTML = `<option value="">${t("topbar.agentFilter.all")}</option>`;
    for (const a of active) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.display;
      agentFilterSelect.appendChild(opt);
    }
    agentFilterSelect.value = active.some((a) => a.id === agentFilter) ? agentFilter : current && active.some((a) => a.id === current) ? current : "";
    if (agentFilter && agentFilterSelect.value !== agentFilter) setAgentFilter("");
  }
  agentFilterSelect.hidden = !multiAgent;
  // "已监测的 Claude Code 会话" → 多家时改成"已监测的 agent 会话"，Claude 星芒仍留着
  const sessionsTitle = document.querySelector('[data-i18n="home.strip.sessions"]');
  if (sessionsTitle) sessionsTitle.textContent = t(multiAgent ? "home.strip.sessionsMulti" : "home.strip.sessions");

  // 首页卡片
  const card = document.getElementById("strip-agents");
  const list = document.getElementById("strip-agents-list");
  card.hidden = !multiAgent;
  if (multiAgent) {
    list.innerHTML = active
      .map(
        (a) => `<div class="agent-row">${agentBadge(a.id, true)}<span class="cap">${escapeHtml(
          t("home.strip.agentRow", { sessions: a.sessions, blocked: a.blocked, bypass: a.bypass })
        )}</span></div>`
      )
      .join("") + (active.some((a) => a.status === "experimental")
        ? `<div class="agent-row cap">${escapeHtml(t("agents.experimental.note"))}</div>` : "");
  }
}

function setAgentFilter(id) {
  agentFilter = id || "";
  try {
    localStorage.setItem(AGENT_FILTER_KEY, agentFilter);
  } catch (e) {
    // ignore
  }
  lastLogId = 0;
  document.getElementById("log-list-full").innerHTML = "";
  refreshLogSessionOptions();
  pollLogs();
}

agentFilterSelect.addEventListener("change", () => setAgentFilter(agentFilterSelect.value));

// ---------- 首页概览 ----------
async function refreshOverview() {
  const s = await api("/api/overview");
  if (!s) return;
  document.getElementById("stat-live-sessions").textContent = s.liveSessionCount;
  document.getElementById("stat-total-sessions").textContent = s.sessionCount;
  document.getElementById("stat-total-events").textContent = s.total;
  document.getElementById("stat-blocked").textContent = s.blockedTotal;
  // macOS 上执行层交叉验证根本没有运行（探针用 nettop，看不到 execve），这时显示 "0"
  // 会被读成"查过了，没问题"。显示 n/a 并在 tooltip 里说明，是能力缺失不是安全结论。
  const bypassEl = document.getElementById("stat-bypass");
  const bypassCard = bypassEl.closest(".strip-card");
  if (s.bypassSupported === false) {
    bypassEl.textContent = t("home.strip.bypassNA");
    if (bypassCard) bypassCard.title = t("home.strip.bypassNATip");
  } else {
    bypassEl.textContent = s.bypassTotal;
    if (bypassCard) bypassCard.removeAttribute("title");
  }
  document.getElementById("stat-tool-calls").textContent = s.toolCalls;
  document.getElementById("stat-mcp-calls").textContent = s.mcpCalls;
  document.getElementById("stat-skill-calls").textContent = s.skillCalls;
  document.getElementById("stat-subagent-calls").textContent = s.subagentCalls;
  document.getElementById("stat-search-calls").textContent = s.searchCalls;
  document.getElementById("stat-todo-calls").textContent = s.todoCalls;
  document.getElementById("stat-ai-trajectory").textContent = s.aiTrajectory;

  if (s.fileOps) {
    document.getElementById("stat-file-reads").textContent = s.fileOps.reads;
    document.getElementById("stat-file-writes").textContent = s.fileOps.writes;
    document.getElementById("stat-file-edits").textContent = s.fileOps.edits;
    document.getElementById("stat-file-deletes").textContent = s.fileOps.deletes;
  }
  if (s.installOps) {
    // 分组名就是元素 id 后缀，后端加一组、前端加一张卡即可，不用再动这里。
    for (const [key, n] of Object.entries(s.installOps)) {
      const el = document.getElementById("stat-install-" + key);
      if (el) el.textContent = n;
    }
  }
  document.getElementById("stat-github-total").textContent = s.githubOpsTotal;
  document.getElementById("stat-ssh-total").textContent = s.sshOpsTotal;
  document.getElementById("stat-download-total").textContent = s.downloadOpsTotal;
  document.getElementById("stat-docker-total").textContent = s.dockerOpsTotal;
  document.getElementById("stat-archive-total").textContent = s.archiveOpsTotal;
  document.getElementById("stat-netdiag-total").textContent = s.netdiagOpsTotal;
  document.getElementById("stat-reverseeng-total").textContent = s.reverseEngOpsTotal;
  document.getElementById("stat-procbg-total").textContent = s.procbgOpsTotal;
  document.getElementById("stat-sensitive-total").textContent = s.sensitiveOpsTotal;
  document.getElementById("stat-kernel-ops-total").textContent = s.kernelOpsTotal;
  {
    // 副标题按实际分布写：有疑似绕过/对外监听就点名，让红字有理由
    const b = new Map((s.kernelOpsBreakdown || []).map((r) => [r.kind, r.n]));
    const parts = [];
    if (b.get("bypass")) parts.push(t("home.kernelOps.bypass", { n: b.get("bypass") }));
    if (b.get("listenExposed")) parts.push(t("home.kernelOps.listenExposed", { n: b.get("listenExposed") }));
    const sub = document.getElementById("stat-kernel-ops-sub");
    sub.textContent = parts.length ? parts.join(" · ") : t("home.kernelOps.sub");
  }
  document.getElementById("stat-sensitive-data-total").textContent = s.sensitiveDataTotal;
  document.getElementById("stat-advanced-threat-total").textContent = s.advancedThreatTotal;
  document.getElementById("stat-workdir-escape-total").textContent = s.workdirEscapeTotal;
  if (Array.isArray(s.workdirEscapeBreakdown)) {
    // 卡片下面的小字：读/写各多少、其中落在敏感位置（家目录隐藏文件/别的用户/系统目录）的多少
    const byKind = Object.fromEntries(s.workdirEscapeBreakdown.map((r) => [r.kind, r.n]));
    const n = (k) => byKind[k] || 0;
    document.getElementById("stat-workdir-escape-sub").textContent = t("home.workdirEscape.sub", {
      read: n("readSensitive") + n("readOther"),
      write: n("writeSensitive") + n("writeOther"),
      sensitive: n("readSensitive") + n("writeSensitive"),
    });
  }
  if (s.screenshotOps) {
    document.getElementById("stat-screenshot").textContent = s.screenshotOps.total;
  }

  // 日志类型是"身份"型分类，六项各一色而不是统一的强调色——原来六行全是同一个蓝，
  // 颜色不承载任何信息。配色是 --cat-1..6（见 style.css 里那段说明，跑过可读性验证）。
  //
  // 两条约束：颜色按 source 这个键绑定，不按名次，所以筛选或数量变化不会让剩下的行换色；
  // 渲染顺序用 SOURCE_ORDER 固定，因为配色的色盲分离度是按"相邻两项"验证的，顺序一变
  // 相邻关系就变了，验证结论也就不作数了。不在表里的新 source 排在最后、用中性灰。
  const ordered = SOURCE_ORDER.map((key) => s.bySource.find((r) => r.source === key)).filter(Boolean);
  const rest = s.bySource.filter((r) => !SOURCE_COLOR[r.source]);
  renderBarList("source-breakdown", [...ordered, ...rest].map((r) => ({
    name: sourceLabel2(r.source) || r.source || "-",
    count: r.n,
    color: SOURCE_COLOR[r.source] || "var(--text-dim)",
  })));
  renderBarList("risk-breakdown", s.byRisk.map((r) => ({
    name: riskLabel(r.risk) || r.risk || "-",
    count: r.n,
    color: RISK_COLOR[r.risk] || "var(--text-dim)",
  })));
  renderBarList("decision-breakdown", s.byDecision.map((r) => ({
    name: decisionLabel(r.decision) || r.decision || "-",
    count: r.n,
    color: DECISION_COLOR[r.decision] || "var(--text-dim)",
  })));
}

// 日志类型的固定渲染顺序 + 配色。顺序和 style.css 里 --cat-1..6 的验证顺序一一对应，
// 改任何一边都要同时改另一边，并重跑 dataviz 的 validate_palette.js。
const SOURCE_ORDER = ["hook_lifecycle", "hook_post", "hook_pre", "hook_prompt", "os_exec", "os_net", "os_file", "os_listen"];
const SOURCE_COLOR = {
  hook_lifecycle: "var(--cat-1)",
  hook_post: "var(--cat-2)",
  hook_pre: "var(--cat-3)",
  hook_prompt: "var(--cat-4)",
  os_exec: "var(--cat-5)",
  os_net: "var(--cat-6)",
  os_file: "var(--cat-7)",
  os_listen: "var(--cat-8)",
};

function renderBarList(containerId, rows) {
  const el = document.getElementById(containerId);
  if (rows.length === 0) {
    el.innerHTML = '<div class="empty-state">暂无数据</div>';
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.count));
  el.innerHTML = rows
    .map(
      (r) => `
    <div class="bar-row">
      <span class="dot" style="background:${r.color}"></span>
      <span class="name">${escapeHtml(r.name)}</span>
      <span class="track"><span class="fill" style="width:${(r.count / max) * 100}%;background:${r.color}"></span></span>
      <span class="count">${r.count}</span>
    </div>`
    )
    .join("");
}

// ---------- 介入级别：三档分段控件 ----------
// 三档互斥，做成并排的 radiogroup：三档同时可见、点哪档去哪档、任意两档一步可达，
// 控件本身就是状态显示。旧版是"切换按钮 + 单独的停止按钮"，按钮上写的是动作不是状态，
// 任何时刻只看得到一个选项；而且从"已关闭"出发时切换按钮指向"拦截中"，导致关闭态
// 没法一步切到观察模式，必须先开回拦截再切一次，中间那一下是真的在拦截的。
// 注意别再把 paused 叫成"暂停审计"——那一档审计照常在跑，停的只是拦截，所以对外叫
// "观察模式 / permissive"（取名参考 SELinux permissive）。磁盘和接口上的值仍是 paused。
const auditSeg = document.getElementById("audit-level-seg");
const auditSegOpts = auditSeg ? Array.from(auditSeg.querySelectorAll(".seg-opt")) : [];
function applyAuditState(state) {
  document.getElementById("audit-state-pill").className = "pill audit-state-" + state;
  document.getElementById("audit-state-text").textContent = t("auditState." + state);
  // 首页态势摘要条第一张卡：同一个状态在顶栏 pill 和首页各显示一份
  const stripDot = document.getElementById("strip-audit-dot");
  if (stripDot) {
    stripDot.className = "strip-dot " + state;
    const key = { running: "home.strip.auditRunning", paused: "home.strip.auditPaused", stopped: "home.strip.auditStopped" }[state];
    document.getElementById("strip-audit-text").textContent = key ? t(key) : state;
  }

  // 分段控件：当前档 aria-checked=true（CSS 的选中态也挂在这个属性上，样式和可访问性
  // 用同一个事实来源，不会出现"看着选中了但读屏器说没选"）。
  for (const opt of auditSegOpts) {
    const on = opt.dataset.level === state;
    opt.setAttribute("aria-checked", on ? "true" : "false");
    // 只有当前档从 tab 序列里可达，方向键在组内移动——这是 radiogroup 的标准交互，
    // 免得三个段各占一次 tab。
    opt.tabIndex = on ? 0 : -1;
  }
  const note = document.getElementById("audit-level-note");
  if (note) note.textContent = t("home.auditCtl.levelNote." + state);
}
async function refreshAuditState() {
  const info = await api("/api/audit-state");
  if (!info) return;
  applyAuditState(info.state);
}
async function setAuditState(state) {
  const info = await api("/api/audit-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  if (!info) return;
  applyAuditState(info.state);
}
// 点任意一段直接切到那一档——三档两两之间都是一步可达，包括以前到不了的
// "已关闭 → 观察模式"。只有切到"已关闭"要二次确认：那一档会真的停掉记录，
// 跟另外两档性质不同，误点的代价是一段时间内什么都没留下。
async function chooseAuditLevel(level) {
  if (!level) return;
  const current = auditSegOpts.find((o) => o.getAttribute("aria-checked") === "true");
  if (current && current.dataset.level === level) return; // 点的就是当前档，什么都不做
  if (level === "stopped") {
    const ok = await confirmDialog(t("modal.stopAudit.title"), t("modal.stopAudit.body"));
    if (!ok) return;
  }
  setAuditState(level);
}

if (auditSeg) {
  auditSeg.addEventListener("click", (e) => {
    const opt = e.target.closest(".seg-opt");
    if (opt) chooseAuditLevel(opt.dataset.level);
  });
  // 方向键在组内移动并直接选中，Home/End 跳到首尾——radiogroup 的常规键盘行为。
  auditSeg.addEventListener("keydown", (e) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = auditSegOpts.findIndex((o) => o.getAttribute("aria-checked") === "true");
    const last = auditSegOpts.length - 1;
    let next;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else {
      const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
      next = Math.min(last, Math.max(0, (i < 0 ? 0 : i) + step));
    }
    const target = auditSegOpts[next];
    if (target) {
      target.focus();
      chooseAuditLevel(target.dataset.level);
    }
  });
}

// ---------- 是否允许其它设备访问这个 Web UI ----------
// 这个开关只是把意图写进一个标志位；进程实际监听的地址是启动时就定死的，标志位改了
// 不会让 127.0.0.1 变成能被局域网连上——真要生效，管理员得显式设
// CC_MONITOR_WEBUI_HOST=0.0.0.0 重启进程。这里用 listeningHost 字段判断当前是不是
// "改了但还没真正生效"，提示清楚，不让人误以为点一下开关就已经暴露到网络上了
// （或者反过来，以为关掉开关就真的把端口锁回本机了——端口有没有对外开放看的是
// 启动参数，不是这个标志位）。
const remoteAccessToggle = document.getElementById("remote-access-toggle");
const remoteAccessNote = document.getElementById("remote-access-note");
function applyRemoteAccessState(info) {
  remoteAccessToggle.checked = info.allowRemote;
  const pill = document.getElementById("remote-access-row");
  pill.classList.toggle("active", info.allowRemote);
  if (info.listeningHost === "127.0.0.1") {
    remoteAccessNote.textContent = t("home.remoteAccess.stillLocalOnly");
  } else if (info.allowRemote) {
    remoteAccessNote.textContent = t("home.remoteAccess.liveWarning", { host: info.listeningHost });
  } else {
    remoteAccessNote.textContent = t("home.remoteAccess.liveBlocked", { host: info.listeningHost });
  }
}
async function refreshRemoteAccessState() {
  const info = await api("/api/remote-access-state");
  if (!info) return;
  applyRemoteAccessState(info);
}
remoteAccessToggle.addEventListener("change", async () => {
  const wantsOn = remoteAccessToggle.checked;
  if (wantsOn) {
    const ok = await confirmDialog(t("modal.remoteAccess.title"), t("modal.remoteAccess.body"));
    if (!ok) {
      remoteAccessToggle.checked = false;
      return;
    }
  }
  const info = await api("/api/remote-access-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allowRemote: wantsOn }),
  });
  if (!info) return;
  applyRemoteAccessState(info);
});

// ---------- 数据管理：持久化归档 / 清空当前数据 / 历史数据记录列表 ----------
const archiveModal = document.getElementById("archive-modal");
const archiveLabelInput = document.getElementById("archive-label");

document.getElementById("archive-data-btn").addEventListener("click", () => {
  archiveLabelInput.value = "";
  archiveModal.hidden = false;
  archiveLabelInput.focus();
});
document.getElementById("archive-cancel").addEventListener("click", () => (archiveModal.hidden = true));
archiveModal.addEventListener("click", (ev) => {
  if (ev.target === archiveModal) archiveModal.hidden = true;
});
async function confirmArchive() {
  const label = archiveLabelInput.value.trim();
  archiveModal.hidden = true;
  const result = await api("/api/archives", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: label || undefined }),
  });
  if (!result) return;
  // 归档不清空当前数据，只是多存一份快照——切到"历史数据"页让用户直接看到刚存的这条,
  // 比留在首页看不出任何变化更有反馈感。
  document.querySelector('.tab-btn[data-tab="archives"]').click();
  refreshArchivesList();
}
document.getElementById("archive-confirm").addEventListener("click", confirmArchive);
archiveLabelInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") confirmArchive();
});

document.getElementById("clear-data-btn").addEventListener("click", async () => {
  const ok = await confirmDialog(t("modal.clearData.title"), t("modal.clearData.body"));
  if (!ok) return;
  const result = await api("/api/events/clear", { method: "POST" });
  if (!result) return;
  // 跟切换语言时一样：已经拼进 DOM 里的日志/Tap 条目不是"状态"，不会自动清空，
  // 数据没了但界面还留着旧条目会很奇怪，干脆重置增量游标、清空列表再整体刷新一遍。
  lastLogId = 0;
  document.getElementById("log-list-full").innerHTML = "";
  tapNextLine = 0;
  document.getElementById("tap-list").innerHTML = "";
  refreshEverythingNow();
});

document.getElementById("sync-update-btn").addEventListener("click", async () => {
  const ok = await confirmDialog(t("modal.syncUpdate.title"), t("modal.syncUpdate.body"));
  if (!ok) return;
  const btn = document.getElementById("sync-update-btn");
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = t("home.syncUpdate.running");
  const result = await api("/api/sync-update", { method: "POST" });
  btn.disabled = false;
  btn.textContent = prevText;
  if (!result) return;
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  alert((result.ok ? t("home.syncUpdate.ok") : t("home.syncUpdate.fail")) + (output ? "\n\n" + output : ""));
});

function archiveRangeText(a) {
  if (!a.firstTs || !a.lastTs) return "-";
  return a.firstTs === a.lastTs ? a.firstTs : `${a.firstTs} ~ ${a.lastTs}`;
}

async function refreshArchivesList() {
  const list = document.getElementById("archives-list");
  const rows = await api("/api/archives");
  if (!rows) return;
  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-state">${t("archives.empty")}</div>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (a) => `
    <div class="archive-item" data-id="${escapeHtml(a.id)}">
      <div class="archive-main">
        <div class="archive-label">${escapeHtml(a.label || t("archives.unnamed"))}</div>
        <div class="archive-meta">
          <span>${t("archives.createdAt")}: ${escapeHtml(a.createdAt)}</span>
          <span>${t("archives.eventCount")}: ${a.total}</span>
          <span>${t("archives.sessionCount")}: ${a.sessionCount}</span>
          <span>${t("archives.range")}: ${escapeHtml(archiveRangeText(a))}</span>
        </div>
      </div>
      <div class="archive-actions">
        <button class="btn-secondary archive-open" data-id="${escapeHtml(a.id)}" data-label="${escapeHtml(a.label || t("archives.unnamed"))}">${t("archives.open")}</button>
        <button class="btn-secondary archive-delete" data-id="${escapeHtml(a.id)}">${t("archives.delete")}</button>
      </div>
    </div>`
    )
    .join("");
  list.querySelectorAll(".archive-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog(t("modal.deleteArchive.title"), t("modal.deleteArchive.body"));
      if (!ok) return;
      const result = await api(`/api/archives/${btn.dataset.id}`, { method: "DELETE" });
      if (!result) return;
      refreshArchivesList();
    });
  });
  list.querySelectorAll(".archive-open").forEach((btn) => {
    btn.addEventListener("click", () => openArchiveViewer(btn.dataset.id, btn.dataset.label));
  });
}

// ---------- AI 审批台：action=confirm 的操作，触发它的终端能直接按 y/N，这里也能点 ----------
// 这几个请求都是"卡着等结果"的（hook 进程还在阻塞、Claude Code 那次工具调用还没继续），
// 不是普通审计记录，等的时间越长对方越难受，轮询间隔比其它列表都短。

// 浏览器系统通知：这个页面不在前台（切了标签页、缩小了窗口，甚至整个浏览器都在后台）
// 时，光靠页面里刷新列表没用，人根本看不到。用 Notification API 弹一条系统级通知，
// 点一下能直接跳回来处理。同一条请求只弹一次，不然每 2 秒轮询一次会把人烦死。
const notifiedApprovalIds = new Set();
const APPROVALS_NOTIFY_PREF_KEY = "cc-monitor-approvals-notify-enabled";

// 套在 Electron 桌面版里时，这条浏览器 Notification API 的路不能用：Electron 渲染进程里
// Notification.permission 永远是 "granted"，new Notification() 也不报错，但 macOS 上未正式
// 签名的 app 会被系统静默拒绝（详见 electron-main.js 顶部那段说明）。桌面版由主进程自己
// 轮询待批准列表来提醒（系统通知 + Dock 跳动 + 角标），这里整条关掉，免得两边重复。
const IS_ELECTRON = /\bElectron\//.test(navigator.userAgent);

function approvalsNotifySupported() {
  return !IS_ELECTRON && typeof Notification !== "undefined";
}

function syncApprovalsNotifyBtn() {
  const btn = document.getElementById("approvals-notify-btn");
  if (IS_ELECTRON) {
    btn.hidden = false;
    btn.textContent = t("approvals.notify.electron");
    btn.disabled = true;
    return;
  }
  if (!approvalsNotifySupported()) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  if (Notification.permission === "granted") {
    btn.textContent = t("approvals.notify.enabled");
    btn.disabled = true;
  } else if (Notification.permission === "denied") {
    btn.textContent = t("approvals.notify.blocked");
    btn.disabled = true;
  } else {
    btn.textContent = t("approvals.notify.enable");
    btn.disabled = false;
  }
}

document.getElementById("approvals-notify-btn").addEventListener("click", async () => {
  if (!approvalsNotifySupported()) return;
  const perm = await Notification.requestPermission();
  try {
    localStorage.setItem(APPROVALS_NOTIFY_PREF_KEY, perm === "granted" ? "1" : "0");
  } catch (e) {
    // localStorage 不可用不影响这次授权本身，只是刷新后按钮状态可能得重新点一下
  }
  syncApprovalsNotifyBtn();
});

function plainTextSummary(r) {
  if (r.kind !== "notify") return r.matched_value;
  try {
    const questions = JSON.parse(r.matched_value);
    return questions.map((q) => q.question || "").join(" / ") || r.matched_value;
  } catch (e) {
    return r.matched_value;
  }
}

function notifyNewApprovals(rows) {
  if (!approvalsNotifySupported() || Notification.permission !== "granted") return;
  for (const r of rows) {
    if (notifiedApprovalIds.has(r.id)) continue;
    notifiedApprovalIds.add(r.id);
    const notifTitle =
      r.kind === "notify" ? t("approvals.notify.questionTitle") : r.kind === "permission" ? t("approvals.notify.permissionTitle") : t("approvals.notify.title");
    const n = new Notification(notifTitle, {
      body: `${toolLabel(r.tool_name, r.tool_name)} · ${folderName(r.cwd)}\n${plainTextSummary(r)}`.slice(0, 200),
      tag: `cc-monitor-approval-${r.id}`,
    });
    n.onclick = () => {
      window.focus();
      document.querySelector('.tab-btn[data-tab="approvals"]').click();
      n.close();
    };
  }
  // 已经处理掉的请求（同意/拒绝/过期）不会再出现在下一次轮询结果里，没必要一直占着
  // 这个 Set——按当前这批的 id 反过来清一遍，防止长时间挂着页面导致 Set 无限变大。
  const stillPending = new Set(rows.map((r) => r.id));
  for (const id of notifiedApprovalIds) {
    if (!stillPending.has(id)) notifiedApprovalIds.delete(id);
  }
}

// kind='notify' 的记录（比如 AskUserQuestion）matched_value 存的是 questions 字段
// 原样 JSON.stringify 之后的样子（一个数组，每个元素有 question/header/options）——
// 解析出来排版成"问题 + 选项列表"，解析失败（万一以后 tools 字段形状变了）就照原样
// 转义显示，不让页面直接崩掉。
function formatQuestionValue(matchedValue) {
  try {
    const questions = JSON.parse(matchedValue);
    if (!Array.isArray(questions)) throw new Error("not an array");
    return questions
      .map((q) => {
        const opts = (q.options || []).map((o) => `<li>${escapeHtml(o.label)}${o.description ? ` — ${escapeHtml(o.description)}` : ""}</li>`).join("");
        return `<div class="approval-question">${escapeHtml(q.header ? q.header + "：" : "")}${escapeHtml(q.question || "")}</div><ul class="approval-question-options">${opts}</ul>`;
      })
      .join("");
  } catch (e) {
    return escapeHtml(matchedValue);
  }
}

// 规则元信息（id -> title/desc 中英文）：审批台把"命中了哪条规则"翻译成"要确认的是什么
// 操作"。启动时拉一次、之后跟审批列表一起刷新（用户改了 rules.json 里的文案也能跟上）。
let ruleMetaCache = {};
async function refreshRuleMeta() {
  const meta = await api("/api/rules/meta");
  if (meta && typeof meta === "object") ruleMetaCache = meta;
}
function ruleTitle(ruleId) {
  const m = ruleMetaCache[ruleId];
  if (!m) return null;
  return (currentLang === "en" ? m.title_en || m.title : m.title || m.title_en) || null;
}
function ruleDesc(ruleId) {
  const m = ruleMetaCache[ruleId];
  if (!m) return null;
  return (currentLang === "en" ? m.desc_en || m.desc : m.desc || m.desc_en) || null;
}

async function refreshApprovals() {
  const [rows] = await Promise.all([api("/api/pending-approvals"), refreshRuleMeta()]);
  const badge = document.getElementById("approvals-badge");
  if (!rows) return;
  badge.hidden = rows.length === 0;
  badge.textContent = String(rows.length);
  // 首页态势摘要条的"待审批"卡跟顶栏徽章同源
  const stripPending = document.getElementById("strip-pending");
  if (stripPending) {
    stripPending.textContent = String(rows.length);
    stripPending.classList.toggle("accent-yellow-text", rows.length > 0);
    document.getElementById("strip-pending-cap").textContent = t(rows.length > 0 ? "home.strip.pendingSome" : "home.strip.pendingNone");
  }
  notifyNewApprovals(rows);

  const list = document.getElementById("approvals-list");
  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-state">${t("approvals.empty")}</div>`;
    return;
  }
  list.innerHTML = rows
    .map((r) => {
      const isNotify = r.kind === "notify";
      // kind='permission'：Claude Code 自己要弹的原生确认框（PermissionRequest hook），
      // matched_rule 存的是 "permission:<工具名>" 这种记忆用的 key，不是规则表里的 id，
      // 展示成通俗说明；按钮跟 confirm 一样，选了就通过 decision.behavior 替用户答掉。
      const isPermission = r.kind === "permission";
      // 标题一句话说"要确认的是什么操作"，副标题解释为什么要确认；规则 id 和工具名退到最后
      // 一行小字。三种来源：命中规则的取规则的 title/desc；Claude Code 原生权限确认没有规则，
      // 按工具名给一句；用户自定义规则没写 title 就退回 id。
      let headline;
      let explain;
      if (isPermission) {
        headline = t("approvals.permission.rule");
        explain = t("approvals.permission.explain", { tool: toolLabel(r.tool_name, r.tool_name) });
      } else {
        headline = ruleTitle(r.matched_rule) || r.matched_rule || "-";
        explain = ruleDesc(r.matched_rule) || "";
      }
      const ruleLine = isPermission
        ? escapeHtml(toolLabel(r.tool_name, r.tool_name))
        : `${t("approvals.ruleLabel")} ${escapeHtml(r.matched_rule || "-")} · ${escapeHtml(toolLabel(r.tool_name, r.tool_name))}`;
      return `
    <div class="approval-item${isNotify ? " approval-item-notify" : ""}${isPermission ? " approval-item-permission" : ""}" data-id="${r.id}">
      <div class="row1">
        <span class="ts">${escapeHtml(r.ts)}</span>
        <span class="risk ${r.risk}">${escapeHtml(riskLabel(r.risk))}</span>
        ${agentBadge(r.agent, true)}
        <span class="session-tag">📁 ${escapeHtml(folderName(r.cwd))} · ${r.session_id ? escapeHtml(r.session_id.slice(0, 8)) + "…" : "-"}</span>
      </div>
      <div class="approval-headline">${isNotify ? "" : `<span class="approval-headline-prefix">${t("approvals.needConfirm")}</span>`}${escapeHtml(headline)}</div>
      ${explain ? `<div class="approval-explain">${escapeHtml(explain)}</div>` : ""}
      <div class="approval-rule">${ruleLine}</div>
      ${
        isNotify
          ? `<div class="approval-value">${formatQuestionValue(r.matched_value)}</div>
             <div class="approval-notify-hint">${t("approvals.notify.goToTerminal")}</div>`
          : `<div class="approval-value">${escapeHtml(r.matched_value)}</div>
             ${isPermission ? `<div class="approval-notify-hint">${t("approvals.permission.hint")}</div>` : ""}
             <div class="approval-actions">
               <button class="btn-primary approval-allow" data-id="${r.id}">${t("approvals.allowOnce")}</button>
               <button class="btn-danger approval-deny" data-id="${r.id}">${t("approvals.denyOnce")}</button>
               <button class="btn-secondary approval-allow10" data-id="${r.id}">${t("approvals.allow10m")}</button>
               <button class="btn-secondary approval-allow30" data-id="${r.id}">${t("approvals.allow30m")}</button>
               <button class="btn-secondary approval-always" data-id="${r.id}">${t("approvals.alwaysAllow")}</button>
             </div>`
      }
    </div>`;
    })
    .join("");
  const DECISION_BY_CLASS = {
    "approval-allow": "allow",
    "approval-deny": "deny",
    "approval-allow10": "allow_10m",
    "approval-allow30": "allow_30m",
    "approval-always": "always_allow",
  };
  list.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const decision = Object.entries(DECISION_BY_CLASS).find(([cls]) => btn.classList.contains(cls))?.[1];
      const result = await api(`/api/pending-approvals/${btn.dataset.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!result) return;
      refreshApprovals();
      refreshApprovalHistory();
    });
  });
}

const APPROVAL_STATUS_I18N_KEY = {
  allowed: "approvals.history.status.allowed",
  denied: "approvals.history.status.denied",
  always_allowed: "approvals.history.status.alwaysAllowed",
  allowed_10m: "approvals.history.status.allowed10m",
  allowed_30m: "approvals.history.status.allowed30m",
  expired: "approvals.history.status.expired",
  answered: "approvals.history.status.answered",
  deferred: "approvals.history.status.deferred",
};
const APPROVAL_STATUS_CLASS = {
  allowed: "risk low",
  always_allowed: "risk low",
  allowed_10m: "risk low",
  allowed_30m: "risk low",
  answered: "risk info",
  denied: "risk high",
  expired: "risk medium",
  deferred: "risk info",
};
function approvalStatusLabel(status) {
  const key = APPROVAL_STATUS_I18N_KEY[status];
  return key ? t(key) : status || "-";
}
const APPROVAL_VIA_I18N_KEY = {
  web: "approvals.history.via.web",
  tty: "approvals.history.via.tty",
  post_tool_use: "approvals.history.via.auto",
  timeout: "approvals.history.via.timeout",
};
function approvalViaLabel(via) {
  const key = APPROVAL_VIA_I18N_KEY[via];
  return key ? t(key) : via || "-";
}

// 历史记录（status != 'pending' 的全部记录，长期保存，见 approvals.js 的 listHistory()）——
// 跟上面"待批准"列表不一样，这里不需要频繁轮询，只在真正切到这个 tab 时刷新一次。
// resolved_value 是 notify 类记录（比如 AskUserQuestion）在终端里被回答之后，hook.py
// 从对应 PostToolUse 的 tool_response.answers 里摘出来存的——{问题文本: 回答文本} 的
// JSON，这里只取回答文本本身（问题已经在"匹配内容"那一列显示过了，不用重复）。
function formatAnswerValue(resolvedValue) {
  if (!resolvedValue) return null;
  try {
    const answers = JSON.parse(resolvedValue);
    if (answers && typeof answers === "object" && !Array.isArray(answers)) {
      const vals = Object.values(answers);
      if (vals.length) return vals.join("; ");
    }
  } catch (e) {
    // 不是预期的 JSON 格式，原样显示
  }
  return resolvedValue;
}

async function refreshApprovalHistory() {
  const rows = await api("/api/approvals/history?limit=200");
  const wrap = document.getElementById("approvals-history-wrap");
  if (!rows) return;
  if (rows.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${t("approvals.history.empty")}</div>`;
    return;
  }
  wrap.innerHTML = `
    <table class="dd-table">
      <thead><tr>
        <th>${t("drilldown.col.time")}</th>
        <th>${t("drilldown.col.sessionId")}</th>
        <th>${t("approvals.history.col.tool")}</th>
        <th>${t("approvals.history.col.rule")}</th>
        <th>${t("approvals.history.col.value")}</th>
        <th>${t("approvals.history.col.status")}</th>
        <th>${t("approvals.history.col.answer")}</th>
        <th>${t("approvals.history.col.via")}</th>
      </tr></thead>
      <tbody>
        ${rows
          .map((r) => {
            const answer = formatAnswerValue(r.resolved_value);
            return `<tr>
          <td class="dd-mono dd-nowrap">${escapeHtml((r.resolved_at || r.ts || "").slice(0, 19).replace("T", " "))}</td>
          <td class="dd-mono">${agentBadge(r.agent)}${agentBadge(r.agent) ? " " : ""}${sessionIdCell(r.session_id, r.cwd)}</td>
          <td class="dd-nowrap">${escapeHtml(toolLabel(r.tool_name, r.tool_name))}${r.kind === "notify" ? " (notify)" : r.kind === "permission" ? " (native)" : ""}</td>
          <td title="${escapeHtml(r.matched_rule || "")}">${escapeHtml(r.kind === "permission" ? t("approvals.permission.rule") : ruleTitle(r.matched_rule) || r.matched_rule || "-")}</td>
          <td class="dd-mono dd-clip" title="${escapeHtml(r.matched_value || "")}">${escapeHtml((r.matched_value || "-").slice(0, 60))}</td>
          <td class="dd-nowrap"><span class="${APPROVAL_STATUS_CLASS[r.status] || ""}">${escapeHtml(approvalStatusLabel(r.status))}</span></td>
          <td class="dd-clip" title="${escapeHtml(answer || "")}">${answer ? escapeHtml(answer.slice(0, 60)) : "-"}</td>
          <td class="dd-nowrap">${escapeHtml(approvalViaLabel(r.resolved_via))}</td>
        </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}
// 内容部分直接复用跟"Log 审计"页一样的 renderLogItem() 渲染，看着是一致的。
// 归档是固定不变的快照，不用轮询，事件多的话点"加载更多"往后翻页就行。
let archiveViewerNextId = 0;
let archiveViewerArchiveId = null;
async function loadMoreArchiveEvents(list, loadMoreBtn) {
  const result = await api(`/api/archives/${archiveViewerArchiveId}/events?since_id=${archiveViewerNextId}&limit=500`);
  if (!result) return;
  if (list.querySelector(".empty-state")) list.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const ev of result.events) {
    archiveViewerNextId = Math.max(archiveViewerNextId, ev.id);
    frag.appendChild(renderLogItem(ev));
  }
  list.appendChild(frag);
  loadMoreBtn.hidden = result.events.length < 500;
}
async function openArchiveViewer(id, label) {
  const title = document.getElementById("drilldown-title");
  const body = document.getElementById("drilldown-body");
  title.textContent = `${t("archives.viewerTitle")} · ${label}`;
  body.innerHTML = `<div class="empty-state">${t("drilldown.loading")}</div>`;
  drilldownModal.hidden = false;

  archiveViewerArchiveId = id;
  archiveViewerNextId = 0;
  const list = document.createElement("div");
  list.className = "log-list";
  const loadMoreBtn = document.createElement("button");
  loadMoreBtn.className = "btn-secondary archive-load-more";
  loadMoreBtn.textContent = t("archives.loadMore");
  loadMoreBtn.hidden = true;
  loadMoreBtn.addEventListener("click", () => loadMoreArchiveEvents(list, loadMoreBtn));
  body.innerHTML = "";
  body.appendChild(list);
  body.appendChild(loadMoreBtn);
  await loadMoreArchiveEvents(list, loadMoreBtn);
  if (list.children.length === 0) list.innerHTML = `<div class="empty-state">${t("archives.viewerEmpty")}</div>`;
}

// ---------- 首页统计卡片下钻详情 ----------
const drilldownModal = document.getElementById("drilldown-modal");
document.getElementById("drilldown-close").addEventListener("click", () => (drilldownModal.hidden = true));
drilldownModal.addEventListener("click", (ev) => {
  if (ev.target === drilldownModal) drilldownModal.hidden = true;
});

// 网络流量表格里的"连接次数"点开看这个目标地址的每次连接时间/进程明细，以及网络流量
// 页顶部汇总卡片（总连接次数/不同 IP 数）点开看完整明细——这些元素都是轮询重建
// innerHTML 生成的，事件委托绑在 document 上一次性搞定，不用每次刷新完都重新挂监听器。
document.addEventListener("click", (ev) => {
  const targetEl = ev.target.closest("[data-target-ip]");
  if (targetEl) {
    showTargetConnections(targetEl.dataset.targetIp, targetEl.dataset.targetPort, targetEl.dataset.targetHost);
    return;
  }
  // 首页紧凑布局里，一张卡内可能嵌着更小的可点区域（合并卡里的三个数字、文件操作盒子
  // 里的四个小统计、摘要卡说明行里的"终端会话"），closest 取最近的那个，内层优先。
  const drilldownEl = ev.target.closest(".clickable[data-drilldown]");
  if (drilldownEl) {
    openDrilldown(drilldownEl.dataset.drilldown);
    return;
  }
  const gotoEl = ev.target.closest("[data-goto-tab]");
  if (gotoEl) {
    const tabBtn = document.querySelector(`.tab-btn[data-tab="${gotoEl.dataset.gotoTab}"]`);
    if (tabBtn) tabBtn.click();
  }
});

async function showTargetConnections(ip, port, host) {
  const title = document.getElementById("drilldown-title");
  const body = document.getElementById("drilldown-body");
  const targetLabel = host ? `${host} (${ip}:${port})` : `${ip}:${port}`;
  title.textContent = t("network.targetDrilldown.title", { target: targetLabel });
  body.innerHTML = `<div class="empty-state">${t("drilldown.loading")}</div>`;
  drilldownModal.hidden = false;
  const events = await api("/api/drilldown/ai-trajectory-events");
  if (!events) return;
  const matched = events.filter((e) => e.ip === ip && String(e.port) === String(port));
  if (matched.length === 0) {
    body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
    return;
  }
  body.innerHTML = `
    <table class="dd-table">
      <thead><tr><th>${t("drilldown.col.time")}</th><th>${t("drilldown.col.process")}</th><th>PID</th></tr></thead>
      <tbody>
        ${matched
          .map(
            (e) => `<tr>
          <td class="dd-mono">${escapeHtml((e.ts || "").slice(0, 19))}</td>
          <td class="dd-mono">${escapeHtml(e.comm || "-")}</td>
          <td class="dd-mono">${e.pid ?? "-"}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

// 下钻接口请求失败（比如 Web UI 服务还是旧代码、没有这条新路由，返回 404）时，各分支
// 里的 `if (!result) return;` 会直接退出，弹窗就一直停在"加载中…"——统一在这层兜底：
// 跑完之后占位符还在，就换成一句说明，告诉用户该怎么办。
async function openDrilldown(kind) {
  const body = document.getElementById("drilldown-body");
  try {
    // 好几个下钻要把规则 id 显示成通俗说明（拦截统计、审批历史）。规则文案平时是跟着
    // 审批台一起刷的，首屏可能还没拉到——这里按需补一次（服务端有 5s 缓存，很便宜）。
    if (Object.keys(ruleMetaCache).length === 0) await refreshRuleMeta();
    await openDrilldownInner(kind);
  } finally {
    const placeholder = body.querySelector(".empty-state");
    if (placeholder && body.children.length === 1 && placeholder.textContent === t("drilldown.loading")) {
      placeholder.textContent = t("drilldown.loadFailed");
    }
  }
}

async function openDrilldownInner(kind) {
  const title = document.getElementById("drilldown-title");
  const body = document.getElementById("drilldown-body");
  body.innerHTML = `<div class="empty-state">${t("drilldown.loading")}</div>`;
  drilldownModal.hidden = false;

  if (kind === "live-sessions") {
    title.textContent = t("drilldown.liveSessions.title");
    const rows = await api("/api/sessions");
    if (!rows) return;
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    body.innerHTML = `
      <table class="dd-table">
        <thead><tr>
          <th>${t("drilldown.liveSessions.cwd")}</th><th>${t("drilldown.sessions.sessionId")}</th>
          <th>${t("drilldown.liveSessions.status")}</th>
          <th>${t("drilldown.liveSessions.uptime")}</th><th>${t("drilldown.lastActive")}</th>
          <th>${t("drilldown.liveSessions.clients")}</th>
          <th>${t("drilldown.liveSessions.model")}</th><th>${t("drilldown.liveSessions.events")}</th>
          <th>${t("drilldown.sessions.flags")}</th><th>${t("drilldown.sessions.range")}</th><th></th>
        </tr></thead>
        <tbody>
          ${rows
            .map(
              (s) => `
            <tr class="dd-row-clickable" data-id="${escapeHtml(s.id)}">
              <td>${escapeHtml(s.cwd || "-")}</td>
              <td class="dd-mono">${s.auditSessionId ? escapeHtml(s.auditSessionId) : "-"}</td>
              <td>${renderVital(s.status, s.statusAgoMs)}</td>
              <td class="dd-mono">${formatUptime(Date.now() - s.createdAt)}</td>
              <td class="dd-mono">${s.lastOutputAt ? formatAgo(Date.now() - s.lastOutputAt) : "-"}</td>
              <td>${s.clientCount}</td>
              <td>${escapeHtml(modelShort(s.model) || "-")}</td>
              <td>${s.eventCount === null || s.eventCount === undefined ? "-" : s.eventCount}</td>
              <td>${(s.blockedCount || 0) > 0 ? `🛑${s.blockedCount} ` : ""}${(s.bypassCount || 0) > 0 ? `⚠${s.bypassCount}` : ""}${
                !s.blockedCount && !s.bypassCount ? "-" : ""
              }</td>
              <td class="dd-mono">${s.firstTs ? (s.firstTs || "").slice(0, 19) + " ~ " + (s.lastTs || "").slice(11, 19) : "-"}</td>
              <td>${s.alive ? `<span class="dd-open-hint">${t("drilldown.liveSessions.open")} ›</span>` : ""}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
    body.querySelectorAll(".dd-row-clickable").forEach((tr) => {
      tr.addEventListener("click", () => {
        drilldownModal.hidden = true;
        document.querySelector('.tab-btn[data-tab="terminal"]').click();
        selectSession(tr.dataset.id);
      });
    });
    return;
  }

  if (kind === "sessions") {
    title.textContent = t("drilldown.sessions.title");
    const rows = await api("/api/drilldown/sessions");
    if (!rows) return;
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    body.innerHTML = `
      <table class="dd-table">
        <thead><tr>
          <th>${t("drilldown.sessions.cwd")}</th><th>${t("drilldown.sessions.sessionId")}</th>
          <th>${t("drilldown.sessions.status")}</th><th>${t("drilldown.lastActive")}</th>
          <th>${t("drilldown.sessions.model")}</th>
          <th>${t("drilldown.sessions.tokIn")}</th><th>${t("drilldown.sessions.tokOut")}</th>
          <th>${t("drilldown.sessions.tokCached")}</th><th>${t("drilldown.sessions.tokTotal")}</th>
          <th>${t("drilldown.sessions.events")}</th>
          <th>${t("drilldown.sessions.flags")}</th><th>${t("drilldown.sessions.range")}</th>
        </tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr>
              <td>${escapeHtml(r.cwd || "-")}</td>
              <td class="dd-mono dd-nowrap">${escapeHtml(r.sessionId)}</td>
              <td class="dd-nowrap">${renderVital(r.status, r.statusAgoMs)}</td>
              <td class="dd-mono dd-nowrap">${r.lastTs ? formatAgo(Date.now() - new Date(r.lastTs).getTime()) : "-"}</td>
              <td class="dd-nowrap">${escapeHtml(modelShort(r.model) || "-")}</td>
              <td class="dd-mono dd-nowrap">${r.tokenStats ? formatTokensShort(r.tokenStats.totalInputTokens) : "-"}</td>
              <td class="dd-mono dd-nowrap">${r.tokenStats ? formatTokensShort(r.tokenStats.totalOutputTokens) : "-"}</td>
              <td class="dd-mono dd-nowrap">${r.tokenStats ? formatTokensShort(r.tokenStats.totalCachedTokens) : "-"}</td>
              <td class="dd-mono dd-nowrap">${r.tokenStats ? formatTokensShort(r.tokenStats.totalTokens) : "-"}</td>
              <td class="dd-nowrap">${r.eventCount}</td>
              <td class="dd-nowrap">${r.blockedCount > 0 ? `🛑${r.blockedCount} ` : ""}${r.bypassCount > 0 ? `⚠${r.bypassCount}` : ""}${
                r.blockedCount === 0 && r.bypassCount === 0 ? "-" : ""
              }</td>
              <td class="dd-mono dd-nowrap">${(r.firstTs || "").slice(0, 19)} ~ ${(r.lastTs || "").slice(11, 19)}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
    return;
  }

  if (kind === "claude-processes") {
    title.textContent = t("drilldown.identity.title");
    const result = identityLastResult || (await api("/api/claude-processes"));
    if (!result) return;
    if (result.processes.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    body.innerHTML = `
      <table class="dd-table">
        <thead><tr>
          <th>${t("drilldown.identity.pid")}</th><th>${t("drilldown.identity.user")}</th>
          <th>${t("drilldown.sessions.status")}</th><th>${t("drilldown.lastActive")}</th>
          <th>${t("drilldown.identity.uptime")}</th><th>${t("drilldown.identity.model")}</th>
          <th>${t("drilldown.identity.events")}</th><th>${t("drilldown.identity.rss")}</th>
          <th>${t("drilldown.identity.cwd")}</th>
        </tr></thead>
        <tbody>
          ${result.processes
            .map(
              (p) => `
            <tr${p.user !== result.currentUser ? ' class="dd-row-mismatch"' : ""}>
              <td class="dd-mono dd-nowrap">${p.pid}${p.agent ? " " + agentBadge(p.agent, true) : ""}</td>
              <td class="dd-nowrap">${escapeHtml(p.user)}${p.user === result.currentUser ? " " + t("home.identity.currentTag") : ""}</td>
              <td class="dd-nowrap">${renderVital(p.status, p.statusAgoMs)}</td>
              <td class="dd-mono dd-nowrap">${p.lastEventTs ? formatAgo(Date.now() - new Date(p.lastEventTs).getTime()) : "-"}</td>
              <td class="dd-mono dd-nowrap"${p.startedAt ? ` title="${t("drilldown.identity.startedAt", { t: fmtDateTime24(new Date(p.startedAt)) })}"` : ""}>${formatDuration(p.uptimeSec)}</td>
              <td class="dd-mono dd-nowrap">${
                p.model
                  ? escapeHtml(p.model)
                  : `<span class="hint">${t("drilldown.identity.modelUnknown")}</span>`
              }</td>
              <td class="dd-mono dd-nowrap">${p.eventCount === null || p.eventCount === undefined ? "-" : p.eventCount}</td>
              <td class="dd-mono dd-nowrap">${p.rssKb ? formatBytes(p.rssKb * 1024) : "-"}</td>
              <td title="${escapeHtml(p.args || "")}">${p.cwd ? escapeHtml(p.cwd) : `<span class="hint">${t("drilldown.identity.cwdUnknown")}</span>`}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
    return;
  }

  if (kind === "event-types") {
    title.textContent = t("drilldown.eventTypes.title");
    const [rows, sessionRows] = await Promise.all([api("/api/drilldown/event-types"), api("/api/drilldown/sessions")]);
    if (!rows) return;
    // Session ID 一串十六进制没法识别是哪个会话，跟别处一样补上文件夹名 + 模型。
    const sessionInfo = new Map((sessionRows || []).map((r) => [r.sessionId, r]));
    const describeSession = (sessionId) => {
      const info = sessionInfo.get(sessionId);
      const folder = info ? folderName(info.cwd) : "?";
      const model = info ? modelShort(info.model) : "";
      return `${escapeHtml(folder)}${model ? " · " + escapeHtml(model) : ""} · <span class="dd-mono">${escapeHtml(sessionId.slice(0, 8))}…</span>`;
    };
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    body.innerHTML = rows
      .map(
        (r) => `
      <div class="dd-group">
        <div class="dd-group-title">${escapeHtml(sourceLabel2(r.source))} · ${escapeHtml(
          toolLabel(r.toolName, r.toolName) || t("drilldown.eventTypes.none")
        )} <span class="n">${t("drilldown.eventTypes.times", { n: r.total })}</span></div>
        <table class="dd-table">
          <thead><tr><th>${t("drilldown.eventTypes.sessionId")}</th><th>${t("drilldown.eventTypes.count")}</th></tr></thead>
          <tbody>
            ${
              r.sessions
                .sort((a, b) => b.count - a.count)
                .map((s) => `<tr><td>${describeSession(s.sessionId)}</td><td>${s.count}</td></tr>`)
                .join("") || `<tr><td colspan="2">${t("drilldown.eventTypes.none")}</td></tr>`
            }
          </tbody>
        </table>
      </div>`
      )
      .join("");
    return;
  }

  if (kind === "tool-calls" || kind === "mcp-calls" || kind === "skill-calls" || kind === "subagent-calls" || kind === "search-calls") {
    const groupKind = kind === "mcp-calls" ? "mcp" : kind === "skill-calls" ? "skill" : kind === "subagent-calls" ? "subagent" : kind === "search-calls" ? "search" : "tool";
    title.textContent =
      groupKind === "mcp"
        ? t("drilldown.mcpCalls.title")
        : groupKind === "skill"
          ? t("drilldown.skillCalls.title")
          : groupKind === "subagent"
            ? t("drilldown.subagentCalls.title")
            : groupKind === "search"
              ? t("drilldown.searchCalls.title")
              : t("drilldown.toolCalls.title");
    const result = await api(`/api/drilldown/${kind}`);
    if (!result) return;
    const { breakdown, events } = result;
    if (breakdown.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    const columnLabel =
      groupKind === "mcp"
        ? t("drilldown.mcpCalls.server")
        : groupKind === "skill"
          ? t("drilldown.skillCalls.skill")
          : groupKind === "subagent"
            ? t("drilldown.subagentCalls.type")
            : t("drilldown.toolCalls.tool");
    const rowLabel = (r) => (groupKind === "mcp" ? r.server : groupKind === "skill" ? r.skill : groupKind === "subagent" ? r.subagentType : toolLabel(r.tool_name, r.tool_name));
    const eventLabel = (e) => (groupKind === "skill" ? e.skill : groupKind === "subagent" ? e.subagentType + (e.description ? " — " + e.description : "") : toolLabel(e.tool_name, e.tool_name));
    body.innerHTML = `
      <table class="dd-table">
        <thead><tr>
          <th>${columnLabel}</th>
          <th>${t("drilldown.toolCalls.count")}</th>
        </tr></thead>
        <tbody>
          ${breakdown.map((r) => `<tr><td>${escapeHtml(rowLabel(r))}</td><td>${r.n}</td></tr>`).join("")}
        </tbody>
      </table>
      <div class="box-title" style="margin:18px 0 8px;">${t("drilldown.eventDetail")}</div>
      <table class="dd-table">
        <thead><tr>
          <th>${t("drilldown.col.time")}</th>
          <th>${t("drilldown.col.sessionId")}</th>
          <th>${t("drilldown.col.cwd")}</th>
          <th>${columnLabel}</th>
        </tr></thead>
        <tbody>
          ${
            events
              .map(
                (e) => `<tr>
              <td class="dd-mono">${escapeHtml((e.ts || "").slice(0, 19))}</td>
              <td class="dd-mono">${sessionIdCell(e.session_id, e.cwd)}</td>
              <td>${escapeHtml(e.cwd || "-")}</td>
              <td>${escapeHtml(eventLabel(e))}</td>
            </tr>`
              )
              .join("") || `<tr><td colspan="4">${t("drilldown.empty")}</td></tr>`
          }
        </tbody>
      </table>`;
    return;
  }

  const GROUPED_OPS_KINDS = {
    "github-ops": { titleKey: "home.githubOps.title", labels: { push: "home.githubOps.push", clone: "home.githubOps.clone", commit: "home.githubOps.commit", pullFetch: "home.githubOps.pullFetch", ghCli: "home.githubOps.ghCli", otherGit: "home.githubOps.otherGit" } },
    "ssh-ops": { titleKey: "home.sshOps.title", labels: { ssh: "home.sshOps.ssh", scp: "home.sshOps.scp", sftp: "home.sshOps.sftp", keyManagement: "home.sshOps.keyManagement", other: "home.sshOps.other" } },
    "download-ops": { titleKey: "home.downloadOps.title", labels: { wget: "home.downloadOps.wget", curl: "home.downloadOps.curl", aria2: "home.downloadOps.aria2", other: "home.downloadOps.other" } },
    "docker-ops": { titleKey: "home.dockerOps.title", labels: { run: "home.dockerOps.run", build: "home.dockerOps.build", exec: "home.dockerOps.exec", compose: "home.dockerOps.compose", other: "home.dockerOps.other" } },
    "archive-ops": { titleKey: "home.archiveOps.title", labels: { tar: "home.archiveOps.tar", zip: "home.archiveOps.zip", sevenZip: "home.archiveOps.sevenZip", gzip: "home.archiveOps.gzip", other: "home.archiveOps.other" } },
    "netdiag-ops": { titleKey: "home.netdiagOps.title", labels: { nc: "home.netdiagOps.nc", nmap: "home.netdiagOps.nmap", telnet: "home.netdiagOps.telnet", other: "home.netdiagOps.other" } },
    "reverseeng-ops": { titleKey: "home.reverseEngOps.title", labels: { ida: "home.reverseEngOps.ida", ghidra: "home.reverseEngOps.ghidra", radare2: "home.reverseEngOps.radare2", gdb: "home.reverseEngOps.gdb", other: "home.reverseEngOps.other" } },
    "procbg-ops": { titleKey: "home.procbgOps.title", labels: { nohup: "home.procbgOps.nohup", disown: "home.procbgOps.disown", backgroundJob: "home.procbgOps.backgroundJob", other: "home.procbgOps.other" } },
    "sensitive-ops": { titleKey: "home.sensitiveOps.title", labels: { sshKey: "home.sensitiveOps.sshKey", credential: "home.sensitiveOps.credential", envVar: "home.sensitiveOps.envVar", other: "home.sensitiveOps.other" } },
    "sensitive-data": { titleKey: "home.sensitiveData.title", labels: { credential: "home.sensitiveData.credential", pii: "home.sensitiveData.pii", vpnConfig: "home.sensitiveData.vpnConfig", other: "home.sensitiveData.other" } },
    "advanced-threat": { titleKey: "home.advancedThreat.title", labels: { cryptoMining: "home.advancedThreat.cryptoMining", dbFileWrite: "home.advancedThreat.dbFileWrite", webshell: "home.advancedThreat.webshell", reverseEscapeShell: "home.advancedThreat.reverseEscapeShell", downloadExec: "home.advancedThreat.downloadExec", c2Framework: "home.advancedThreat.c2Framework", postExploitation: "home.advancedThreat.postExploitation", suspiciousMcp: "home.advancedThreat.suspiciousMcp", pentestRecon: "home.advancedThreat.pentestRecon", covertTunnel: "home.advancedThreat.covertTunnel" } },
    "workdir-escape": { titleKey: "home.workdirEscape.title", labels: { writeSensitive: "home.workdirEscape.writeSensitive", writeOther: "home.workdirEscape.writeOther", readSensitive: "home.workdirEscape.readSensitive", readOther: "home.workdirEscape.readOther" } },
    "kernel-ops": { titleKey: "home.kernelOps.title", labels: { write: "home.kernelOps.write", unlink: "home.kernelOps.unlink", rename: "home.kernelOps.rename", mkdir: "home.kernelOps.mkdir", listen: "home.kernelOps.listen", listenExposed: "home.kernelOps.listenExposedKind", bypass: "home.kernelOps.bypassKind", storm: "home.kernelOps.storm", other: "home.kernelOps.other" } },
  };
  // 首页卡片用 accent-red-strong 标红的那几组，下钻详情里的分类徽章也跟着标红加粗。
  // 一开始只标红"敏感操作/敏感数据/高级威胁检测/逆向分析工具调用"这几组，后来陆续被
  // 要求把 GitHub/SSH/下载/Docker/压缩归档/网络诊断/进程管理这些"命令类操作统计"
  // 分组下钻详情里的分类标签也统一标红加粗——干脆对所有走 GROUPED_OPS_KINDS 这条
  // 下钻路径的分组都生效，不用每加一组就来改一次这个集合。
  if (GROUPED_OPS_KINDS[kind]) {
    // GitHub/SSH/下载/Docker/压缩/网络诊断/进程管理这七组——首页原来每组一整排
    // 细分类卡片（合计 30+ 张，刷屏），现在每组只放一张汇总卡片，点开先看分类
    // 小计表（跟 MCP/Skill/子代理调用同一个表格），再往下是完整命令明细列表
    // （复用 log-item 那套带语法高亮的 summaryHtml 渲染，每条前面挂一个分类徽章）。
    const cfg = GROUPED_OPS_KINDS[kind];
    title.textContent = t(cfg.titleKey);
    const result = await api(`/api/drilldown/${kind}`);
    if (!result) return;
    const { breakdown, events } = result;
    if (breakdown.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    const kindLabel = (k) => (cfg.labels[k] ? t(cfg.labels[k]) : k);
    // 首页卡片标红的那几组（敏感操作/敏感数据/高级威胁检测/逆向分析工具调用），下钻
    // 详情里的分类徽章也跟着标红加粗，跟卡片本身的视觉分量对上，不是所有分组都要。
    const badgeCls = "dd-badge-category dd-badge-danger";
    const tdCls = " class=\"dd-badge-danger\"";
    body.innerHTML = `
      <table class="dd-table">
        <thead><tr><th>${t("drilldown.opsBreakdown.category")}</th><th>${t("drilldown.toolCalls.count")}</th></tr></thead>
        <tbody>
          ${breakdown.map((r) => `<tr><td${tdCls}>${escapeHtml(kindLabel(r.kind))}</td><td>${r.n}</td></tr>`).join("")}
        </tbody>
      </table>
      <div class="box-title" style="margin:18px 0 8px;">${t("drilldown.eventDetail")}</div>
      ${
        events
          .map(
            (r) => `
      <div class="log-item">
        <div class="row1">
          <span class="ts">${r.ts}</span>
          <span class="${badgeCls}">${escapeHtml(kindLabel(r.kind))}</span>
          ${agentBadge(r.agent)}
          <span class="label dd-badge-danger">${escapeHtml(toolLabel(r.toolName, r.label))}</span>
        </div>
        <div class="cwd">${sessionCwdLine(r)}</div>
        <div class="summary">${r.summaryHtml || ""}</div>
        ${(r.extra || []).map((e) => `<div class="extra ${escapeHtml(e.cls || "")}">${e.html}</div>`).join("")}
      </div>`
          )
          .join("") || `<div class="empty-state">${t("drilldown.empty")}</div>`
      }`;
    return;
  }

  if (kind === "ai-trajectory") {
    title.textContent = t("drilldown.aiTrajectory.title");
    const [result, connectEvents] = await Promise.all([api(`/api/network-traffic?limit=500&lang=${currentLang}`), api("/api/drilldown/ai-trajectory-events")]);
    if (!result) return;
    const rows = result.rows;
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    body.innerHTML = `
      <table class="dd-table">
        <thead><tr>
          <th>${t("network.col.target")}</th><th>${t("network.col.location")}</th>
          <th>${t("network.col.tx")}</th><th>${t("network.col.rx")}</th>
          <th>${t("network.col.connects")}</th>
        </tr></thead>
        <tbody>
          ${rows
            .map((r) => {
              const badge = r.inferred ? `<span class="dd-badge-inferred" title="${t("network.inferredHint")}">${t("network.inferredBadge")}</span> ` : "";
              const target = r.host ? `${badge}${escapeHtml(r.host)}<br><span class="dd-mono hint">${escapeHtml(r.ip)}${r.port ? ":" + r.port : ""}</span>` : `${badge}<span class="dd-mono">${escapeHtml(r.ip)}${r.port ? ":" + r.port : ""}</span>`;
              const countryLabel = r.geo ? r.geo.country || r.geo.countryCode : null;
              const loc = r.geo ? escapeHtml([r.geo.city, countryLabel].filter(Boolean).join(", ") || "-") : `<span class="hint">${t("network.noLocation")}</span>`;
              return `<tr>
                <td>${target}</td>
                <td>${loc}</td>
                <td>${formatBytes(r.txBytes)}</td>
                <td>${formatBytes(r.rxBytes)}</td>
                <td><span class="dd-open-hint" style="cursor:pointer;" data-target-ip="${escapeHtml(r.ip)}" data-target-port="${r.port}" data-target-host="${escapeHtml(r.host || "")}">${r.connectCount} ›</span></td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
      <div class="box-title" style="margin:18px 0 4px;">${t("drilldown.eventDetail")}</div>
      <div class="hint" style="margin-bottom:10px;">${t("drilldown.aiTrajectory.noSessionHint")}</div>
      <table class="dd-table">
        <thead><tr>
          <th>${t("drilldown.col.time")}</th>
          <th>${t("drilldown.col.process")}</th>
          <th>${t("network.col.target")}</th>
          <th>${t("drilldown.sessions.sessionId")}</th>
          <th>PID</th>
        </tr></thead>
        <tbody>
          ${
            (connectEvents || [])
              .map((e) => {
                const badge = e.inferred ? `<span class="dd-badge-inferred" title="${t("network.inferredHint")}">${t("network.inferredBadge")}</span> ` : "";
                const target = e.host ? `${badge}${escapeHtml(e.host)}<br><span class="dd-mono hint">${escapeHtml(e.ip || "")}:${e.port ?? "-"}</span>` : `${badge}<span class="dd-mono">${escapeHtml(e.ip || "-")}:${e.port ?? "-"}</span>`;
                const proc = `<span class="dd-mono">${escapeHtml((e.comm || "-").slice(0, 60))}</span>`;
                const session = e.inferred && e.sessionId ? `${escapeHtml(folderName(e.cwd))} · ${escapeHtml(e.sessionId.slice(0, 8))}…` : `<span class="hint">-</span>`;
                return `<tr>
                <td class="dd-mono">${escapeHtml((e.ts || "").slice(0, 19))}</td>
                <td>${proc}</td>
                <td>${target}</td>
                <td>${session}</td>
                <td class="dd-mono">${e.pid ?? "-"}</td>
              </tr>`;
              })
              .join("") || `<tr><td colspan="5">${t("drilldown.empty")}</td></tr>`
          }
        </tbody>
      </table>`;
    return;
  }

  if (kind === "blocked") {
    title.textContent = t("drilldown.blocked.title");
    const rows = await api("/api/drilldown/blocked");
    if (!rows) return;
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.blocked.empty")}</div>`;
      return;
    }
    // 明细列表之前先给一组统计：光是一长串事件很难看出"到底主要在拦什么"。
    // 三个维度都从已经拿到的 rows 里现算，不用再打接口。
    const countBy = (keyFn) => {
      const m = new Map();
      for (const r of rows) {
        const k = keyFn(r);
        m.set(k, (m.get(k) || 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const byRule = countBy((r) => r.matchedRule || "-");
    const byTool = countBy((r) => r.toolName || "-");
    const byDir = countBy((r) => r.cwd || "-");
    const now = Date.now();
    const since = (ms) => rows.filter((r) => now - new Date(r.ts).getTime() <= ms).length;
    const statTable = (titleKey, entries, labelFn) => `
      <div class="home-box">
        <div class="box-title">${t(titleKey)}</div>
        <table class="dd-table">
          <thead><tr><th>${t("drilldown.blocked.category")}</th><th>${t("drilldown.blocked.count")}</th></tr></thead>
          <tbody>
            ${entries
              .map(([k, n]) => `<tr><td class="dd-badge-danger">${escapeHtml(labelFn(k))}</td><td class="dd-nowrap">${n}</td></tr>`)
              .join("")}
          </tbody>
        </table>
      </div>`;
    body.innerHTML = `
      <div class="home-grid cols-3" style="margin-bottom:14px;">
        <div class="card dense"><div class="card-num accent-red-text">${rows.length}</div><div class="card-label">${t("drilldown.blocked.total")}</div></div>
        <div class="card dense"><div class="card-num">${since(24 * 3600 * 1000)}</div><div class="card-label">${t("drilldown.blocked.last24h")}</div></div>
        <div class="card dense"><div class="card-num">${since(7 * 24 * 3600 * 1000)}</div><div class="card-label">${t("drilldown.blocked.last7d")}</div></div>
      </div>
      <div class="home-grid cols-3" style="margin-bottom:18px;">
        ${statTable("drilldown.blocked.byRule", byRule, (k) => ruleTitle(k) || k)}
        ${statTable("drilldown.blocked.byTool", byTool, (k) => toolLabel(k, k))}
        ${statTable("drilldown.blocked.byDir", byDir, (k) => folderName(k) || k)}
      </div>
      <div class="box-title" style="margin:0 0 8px;">${t("drilldown.eventDetail")}</div>
      ${rows
        .map(
          (r) => `
      <div class="log-item">
        <div class="row1">
          <span class="ts">${r.ts}</span>
          <span class="risk high">${escapeHtml(riskLabel("high"))}</span>
          <span class="label op-${operationCategory(r)}">${escapeHtml(toolLabel(r.toolName, r.label))}</span>
          <span class="decision blocked">${escapeHtml(decisionLabel("blocked"))}</span>
        </div>
        <div class="cwd">${sessionCwdLine(r)}<span class="sep"> · </span><span class="rule">${escapeHtml(
            ruleTitle(r.matchedRule) || r.matchedRule || "-"
          )}</span></div>
        <div class="summary">${r.summaryHtml || ""}</div>
      </div>`
        )
        .join("")}`;
    return;
  }

  if (kind === "screenshot") {
    // 只有一张卡片、不分子类型，跟上面那组"file-op-/install-op-/github-op-"的
    // 共用逻辑不一样——单独处理，直接调 /api/drilldown/screenshot，不用拼 opType。
    title.textContent = t("home.screenshotOps.total") + " — " + t("drilldown.fileOp.suffix");
    const result = await api("/api/drilldown/screenshot");
    if (!result) return;
    const rows = result.events || [];
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    // "真的截了屏"和"只是打开了一张图片"必须分开看：这张卡里绝大多数其实是后者，
    // 混成一个数字的时候，截图命令有没有被检测到完全看不出来。
    const shotKindLabel = (k) => t("drilldown.screenshot.kind." + k) || k;
    const bd = result.breakdown || [];
    const realShots = bd.filter((r) => r.kind !== "imageRead").reduce((a, r) => a + r.n, 0);
    body.innerHTML = `
      <div class="home-grid cols-3" style="margin-bottom:14px;">
        <div class="card dense"><div class="card-num accent-red-text">${realShots}</div><div class="card-label">${t("drilldown.screenshot.realTotal")}</div></div>
        ${bd
          .map(
            (r) =>
              `<div class="card dense"><div class="card-num shot-kind-${escapeHtml(r.kind || "")}">${r.n}</div><div class="card-label">${escapeHtml(
                shotKindLabel(r.kind)
              )}</div></div>`
          )
          .join("")}
      </div>
      <div class="box-title" style="margin:0 0 8px;">${t("drilldown.eventDetail")}</div>
      ${rows
        .map(
          (r) => `
      <div class="log-item">
        <div class="row1">
          <span class="ts">${r.ts}</span>
          <span class="dd-badge-category shot-kind-${escapeHtml(r.kind || "")}">${escapeHtml(shotKindLabel(r.kind))}</span>
          <span class="label op-${operationCategory(r)}">${escapeHtml(toolLabel(r.toolName, r.label))}</span>
        </div>
        <div class="cwd">${sessionCwdLine(r)}</div>
        <div class="summary">${r.summaryHtml || ""}</div>
      </div>`
        )
        .join("")}`;
    return;
  }

  if (kind === "todo-calls") {
    // 单张卡片，不分子类型，跟截屏审计那张一个套路——TodoWrite 没有天然的分类
    // 维度，直接平铺列出最近的调用，每条带上任务列表的条数（不展示任务的具体
    // 文字内容，跟其它下钻卡片"只给基本信息"是同一个尺度）。
    title.textContent = t("home.card.todoCalls") + " — " + t("drilldown.fileOp.suffix");
    const rows = await api("/api/drilldown/todo-calls");
    if (!rows) return;
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    body.innerHTML = rows
      .map(
        (r) => `
      <div class="log-item">
        <div class="row1">
          <span class="ts">${r.ts}</span>
          <span class="label">${escapeHtml(t("drilldown.todoCalls.itemCount", { n: r.todoCount }))}</span>
        </div>
        <div class="cwd">${sessionCwdLine(r)}</div>
      </div>`
      )
      .join("");
    return;
  }

  const OP_DRILLDOWN_PREFIXES = ["file-op-", "install-op-"];
  if (OP_DRILLDOWN_PREFIXES.some((p) => kind.startsWith(p))) {
    // 文件操作（读/写/编辑/删除）、软件安装（pip/系统包/npm/其它）这两组下钻详情
    // 数据形状、渲染方式完全一样，就是后端接口路径前缀不同，合并成一份处理逻辑。
    // GitHub/SSH/下载/Docker/压缩/网络诊断/进程管理这七组以前也在这个大家族里，
    // 首页改成每组一张汇总卡片之后，挪到下面 GROUPED_OPS_KINDS 那个专门的分支了
    // （那七组下钻现在是"分类小计表 + 事件明细"，跟 file-op/install-op 这种平铺
    // 列表已经不是同一种形状）。
    const OP_LABEL_KEYS = {
      "install-op": { pip: "home.installOps.pip", uv: "home.installOps.uv", pythonOther: "home.installOps.pythonOther", js: "home.installOps.js", toolchain: "home.installOps.toolchain", system: "home.installOps.system", other: "home.installOps.other" },
      "file-op": { read: "home.fileOps.reads", write: "home.fileOps.writes", edit: "home.fileOps.edits", delete: "home.fileOps.deletes" },
    };
    const apiKind = OP_DRILLDOWN_PREFIXES.find((p) => kind.startsWith(p)).slice(0, -1);
    const prefix = apiKind + "-";
    const opType = kind.slice(prefix.length);
    const opLabelKey = OP_LABEL_KEYS[apiKind][opType];
    const suffixKey = apiKind === "install-op" ? "drilldown.installOp.suffix" : "drilldown.fileOp.suffix";
    title.textContent = t(opLabelKey) + " — " + t(suffixKey);
    const rows = await api(`/api/drilldown/${apiKind}/${opType}`);
    if (!rows) return;
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.empty")}</div>`;
      return;
    }
    const renderLogItems = (list) =>
      list
        .map(
          (r) => `
      <div class="log-item">
        <div class="row1">
          <span class="ts">${r.ts}</span>
          <span class="label op-${operationCategory(r)}">${escapeHtml(toolLabel(r.toolName, r.label))}</span>
        </div>
        <div class="cwd">${sessionCwdLine(r)}</div>
        <div class="summary">${r.summaryHtml || ""}</div>
      </div>`
        )
        .join("");

    if (apiKind === "install-op" && opType === "npm") {
      // "npm 安装"这张卡片背后是两条不同风险等级的规则（本地 log 级、全局 confirm
      // 级），合并成一个总数好过一眼看出"到底装了多少次 npm 包"，但点开详情不能把
      // 两种混在一起平铺——按 matchedRule 分成两组，各自一个小标题，风险等级不同的
      // 东西不该看起来一样重。
      const local = rows.filter((r) => r.matchedRule === "npm_local_install");
      const global = rows.filter((r) => r.matchedRule === "npm_global_install");
      body.innerHTML = `
        <div class="box-title" style="margin:0 0 8px;">${t("drilldown.installOp.npmGlobal")}</div>
        ${global.length ? renderLogItems(global) : `<div class="empty-state">${t("drilldown.empty")}</div>`}
        <div class="box-title" style="margin:18px 0 8px;">${t("drilldown.installOp.npmLocal")}</div>
        ${local.length ? renderLogItems(local) : `<div class="empty-state">${t("drilldown.empty")}</div>`}
      `;
      return;
    }

    body.innerHTML = renderLogItems(rows);
    return;
  }
}

// ---------- 状态信息页（类 ccstatusline） ----------
// 跟 ccstatusline 的 TokensTotal/TokensCached 挂件同一个格式（"2.6M"/"30.6k"），
// 数字本身也是同一个口径：Total = input+output+cached，Cached = cache_read+cache_creation。
function formatTokensShort(n) {
  if (n === null || n === undefined) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function fmtDuration(fromTs, toTs) {
  try {
    const ms = new Date(toTs.replace(/T/, " ").replace(/-(\d{2}):?(\d{2})$/, "")).getTime() -
      new Date(fromTs.replace(/T/, " ").replace(/-(\d{2}):?(\d{2})$/, "")).getTime();
    const mins = Math.max(0, Math.round(ms / 60000));
    return t("status.durationMinutes", { n: mins < 1 ? "<1" : mins });
  } catch (e) {
    return "-";
  }
}

async function refreshModelUsage() {
  const result = await api("/api/model-usage");
  const wrap = document.getElementById("model-usage-wrap");
  if (!result) return;
  const models = result.models || [];
  if (models.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${t("status.modelUsage.empty")}</div>`;
    return;
  }
  const maxTotal = Math.max(1, ...models.map((m) => m.totalTokens));
  wrap.innerHTML = `
    <table class="dd-table">
      <thead><tr>
        <th>${t("status.modelUsage.col.model")}</th>
        <th>${t("status.modelUsage.col.sessions")}</th>
        <th>${t("status.modelUsage.col.input")}</th>
        <th>${t("status.modelUsage.col.output")}</th>
        <th>${t("status.modelUsage.col.cache")}</th>
        <th>${t("status.modelUsage.col.total")}</th>
      </tr></thead>
      <tbody>
        ${models
          .map((m) => {
            const barPct = Math.round((m.totalTokens / maxTotal) * 100);
            return `<tr>
          <td><b>${escapeHtml(modelShort(m.model))}</b></td>
          <td class="dd-mono">${m.sessionCount}</td>
          <td class="dd-mono">${formatTokensShort(m.inputTokens)}</td>
          <td class="dd-mono">${formatTokensShort(m.outputTokens)}</td>
          <td class="dd-mono">${formatTokensShort(m.cacheReadTokens + m.cacheCreationTokens)}</td>
          <td>
            <div class="neon-bar-cell">
              <div class="neon-bar" style="width:120px;border:1px solid var(--accent);"><div class="neon-bar-fill" style="width:${barPct}%;background:linear-gradient(90deg, color-mix(in srgb, var(--accent) 45%, white), var(--accent));"></div></div>
              <span class="neon-bar-pct" style="color:var(--accent);">${formatTokensShort(m.totalTokens)}</span>
            </div>
          </td>
        </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

async function refreshStatusBoard() {
  const status = await api("/api/status");
  if (!status) return;
  const { liveSessions, auditSessions } = status;
  const board = document.getElementById("status-board");
  const rows = [];

  for (const s of liveSessions) {
    const mins = Math.floor(s.uptimeMs / 60000);
    rows.push(`
      <div class="status-row">
        <span class="seg kind webui">🖥 Web UI</span>
        <span class="seg">${renderVital(s.status, s.statusAgoMs)}</span>
        <span class="seg cwd">📁 ${escapeHtml(s.cwd)}</span>
        ${s.gitBranch ? `<span class="seg branch${s.gitDirty ? " dirty" : ""}">⎇ ${escapeHtml(s.gitBranch)}</span>` : ""}
        <span class="seg">⏱ ${mins < 1 ? t("terminal.justNow") : t("terminal.minutesAgo", { n: mins })}</span>
      </div>`);
  }

  for (const s of auditSessions) {
    const ts = s.tokenStats;
    let tokenSegs = "";
    let contextSeg = "";
    if (ts) {
      const rate = ts.outputTokensPerSec != null ? `${ts.outputTokensPerSec.toFixed(1)} tok/s ↑` : "";
      const rateIn = ts.inputTokensPerSec != null ? `${ts.inputTokensPerSec.toFixed(1)} tok/s ↓` : "";
      const totalShort = formatTokensShort(ts.totalTokens);
      const cachedShort = formatTokensShort(ts.totalCachedTokens);
      tokenSegs = `
        <span class="seg">💬 in=${ts.totalInputTokens} out=${ts.totalOutputTokens}${ts.totalCacheReadTokens ? ` cache=${ts.totalCacheReadTokens}` : ""}</span>
        ${totalShort ? `<span class="seg">Σ Total: ${totalShort}${cachedShort ? " · Cached: " + cachedShort : ""}</span>` : ""}
        ${rate ? `<span class="seg">⚡ ${rate}${rateIn ? " · " + rateIn : ""}</span>` : ""}
      `;
      if (ts.contextTokens != null) {
        // Claude Code 不会把当前模型准确的上下文窗口大小告诉我们的 hooks（只有它自己
        // 的 statusLine 输入才带这个字段），跟 ccstatusline 拿不到时一样退化成按 200K
        // 标准上下文窗口估算——这是个近似值，不是精确读数，UI 文案要说清楚。
        const ctxPct = Math.min(100, Math.round((ts.contextTokens / DEFAULT_CONTEXT_WINDOW) * 100));
        const ctxColor = healthColor(100 - ctxPct);
        contextSeg = `<span class="seg" style="color:${ctxColor};" title="${t("status.contextWindow.hint")}">📐 ${t("status.contextWindow.label")}: ${ctxPct}% (${formatTokensShort(ts.contextTokens)}/200k)</span>`;
      }
    }
    const cs = s.compactionStats;
    const compactionSeg = cs && cs.count > 0
      ? `<span class="seg" title="${t("status.compaction.hint", { n: cs.autoCount, m: cs.manualCount, tokens: formatTokensShort(cs.cumulativeDroppedTokens) })}">🗜 ${t("status.compaction.label", { n: cs.count })}</span>`
      : "";
    rows.push(`
      <div class="status-row">
        <span class="seg kind">🤖 ${folderName(s.cwd)} · ${s.sessionId.slice(0, 8)}…</span>
        <span class="seg">${renderVital(s.status, s.statusAgoMs)}</span>
        ${s.model ? `<span class="seg model">🧠 ${escapeHtml(modelShort(s.model))}</span>` : ""}
        <span class="seg cwd">📁 ${escapeHtml(s.cwd || "-")}</span>
        ${s.gitBranch ? `<span class="seg branch${s.gitDirty ? " dirty" : ""}">⎇ ${escapeHtml(s.gitBranch)}</span>` : ""}
        <span class="seg">⏱ ${fmtDuration(s.firstTs, s.lastTs)}</span>
        <span class="seg">${t("status.eventCount", { n: s.eventCount })}</span>
        ${tokenSegs}
        ${contextSeg}
        ${compactionSeg}
        ${s.blockedCount > 0 ? `<span class="seg blocked">${t("status.blockedCount", { n: s.blockedCount })}</span>` : ""}
        ${s.bypassCount > 0 ? `<span class="seg bypass">${t("status.bypassCount", { n: s.bypassCount })}</span>` : ""}
      </div>`);
  }

  board.innerHTML = rows.join("") || `<div class="empty-state">${t("status.empty")}</div>`;
}

function fmtResetAt(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    // 之前这里用 Math.round(hours) 只精确到小时，"4.98 小时后"和"4.02 小时后"
    // 显示出来都是"5 小时后"，差了快一小时看不出来——重置时间这种东西差几分钟
    // 就可能是"还没刷新"和"已经刷新"的区别，改成精确到分钟。
    const totalMinutes = Math.max(0, Math.round((d.getTime() - Date.now()) / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const when = days > 0 ? t("status.daysHoursLater", { d: days, h: hours }) : t("status.hoursMinutesLater", { h: hours, m: minutes });
    return `${when} (${fmtDateTime24(d)})`;
  } catch (e) {
    return iso;
  }
}

// 5 小时/7 天是接口本身文案里写的窗口长度（"单次额度 (5 小时窗口)"/"周额度"），
// 不是猜的——沙漏要知道"这个窗口总共多长"才能算出"已经过去多少"。
const SESSION_WINDOW_MS = 5 * 3600 * 1000;
const WEEKLY_WINDOW_MS = 7 * 24 * 3600 * 1000;
// Claude Code 不会把当前模型准确的上下文窗口大小告诉我们的 hooks（这个信息只在它
// 自己的 statusLine 输入里才有），跟 ccstatusline 拿不到时一样退化成这个标准值
// （多数模型的标准上下文窗口），是个近似值。
const DEFAULT_CONTEXT_WINDOW = 200000;

let hourglassUidCounter = 0;
// 沙漏：上格剩余沙子 = 1-elapsed，下格已落下的沙子 = elapsed。纯 SVG 画的，不需要图片
// 素材，颜色跟主题的 --accent 联动（渐变的两个 stop 在 CSS 里用 color-mix 从 --accent
// 算出来，换主题自动跟着走）。
//
// 几何：viewBox 28×44，上下各一块托板，中间是经典的沙漏轮廓，两格在 y=21.8 收口。
// 上格的沙子贴着格底（沙子是从颈口漏下去的，所以剩下的堆在下面，液面是平的）；
// 下格的沙子从底部堆起来，用一条二次贝塞尔把顶面拉成中间高的沙堆，比平顶的矩形
// 像真沙子。两格都再 clip 一次，保证任何比例下都不会溢出玻璃轮廓。
// color 传进来的话，沙子就跟着卡片自己的配色走（额度卡的颜色是按健康度算的，绿/黄/橙
// 各不相同），不传就退回主题的 --accent。同一张卡里沙漏跟进度条同色，比一律用强调色整体。
function hourglassSvg(elapsedFraction, color) {
  const e = Math.max(0, Math.min(1, elapsedFraction));
  const uid = `hg${hourglassUidCounter++}`;
  const NECK = 21.8;          // 两格收口处的 y
  const TOP_Y = 6.2;          // 上格顶
  const BOT_Y = 37.8;         // 下格底
  const TOP_H = NECK - TOP_Y; // 上格可容纳的沙高
  const BOT_H = BOT_Y - NECK;

  const topH = (1 - e) * TOP_H;
  const botH = e * BOT_H;
  const topSandY = NECK - topH;
  const botSandY = BOT_Y - botH;
  // 沙堆顶面的隆起高度：沙子越多堆得越尖，但封顶 2.6，免得快满时戳破玻璃。
  const mound = Math.min(3.4, botH * 0.55);

  // 正在漏的时候才画那道落沙；漏完了或还没开始都不画。
  const streaming = e > 0.02 && e < 0.995;
  const sandLight = color ? rgbToHex(lerpRgb(hexToRgb(color), [255, 255, 255], 0.45)) : null;

  return `
    <svg class="hourglass-svg" width="30" height="46" viewBox="0 0 28 44" aria-hidden="true">
      <defs>
        <linearGradient id="${uid}g" x1="0" y1="0" x2="0" y2="44" gradientUnits="userSpaceOnUse">
          <stop class="hg-stop-a" offset="0"${sandLight ? ` style="stop-color:${sandLight}"` : ""}/>
          <stop class="hg-stop-b" offset="1"${color ? ` style="stop-color:${color}"` : ""}/>
        </linearGradient>
        <clipPath id="${uid}t"><path d="M6.4 ${TOP_Y} H21.6 L14 ${NECK} Z"/></clipPath>
        <clipPath id="${uid}b"><path d="M14 ${NECK} L21.6 ${BOT_Y} H6.4 Z"/></clipPath>
      </defs>

      <g clip-path="url(#${uid}t)">
        <rect fill="url(#${uid}g)" x="0" y="${topSandY.toFixed(2)}" width="28" height="${(topH + 0.4).toFixed(2)}"/>
      </g>

      ${streaming ? `<rect class="hg-stream" x="13.5" y="${NECK.toFixed(2)}" width="1" height="${Math.max(0, botSandY - NECK).toFixed(2)}"${color ? ` style="fill:${color}"` : ""}/>` : ""}

      <g clip-path="url(#${uid}b)">
        <path fill="url(#${uid}g)" d="M6.4 ${BOT_Y} H21.6 V${botSandY.toFixed(2)} Q14 ${(botSandY - mound).toFixed(2)} 6.4 ${botSandY.toFixed(2)} Z"/>
      </g>

      <path class="hg-glass" d="M6.4 ${TOP_Y} H21.6 L14 ${NECK} L21.6 ${BOT_Y} H6.4 L14 ${NECK} Z"/>
      <rect class="hg-cap" x="4.6" y="2.6" width="18.8" height="3.2" rx="1.6"/>
      <rect class="hg-cap" x="4.6" y="38.2" width="18.8" height="3.2" rx="1.6"/>
    </svg>`;
}

function hexToRgb(hex) {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const num = parseInt(full, 16) || 0;
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}
function lerpRgb(c1, c2, t) { return [0, 1, 2].map((i) => c1[i] + (c2[i] - c1[i]) * t); }
function themeVarHex(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
// 健康度渐变——0=最危险（红）100=最健康（绿），中间过一道黄，两段线性插值。三个
// 锚点直接读当前主题的 --red/--yellow/--green，不是写死的固定色，换主题这套渐变
// 跟着联动（跟之前"整卡片染色"那次的反馈保持一致：颜色跟主题走，不要写死）。
function healthColor(healthPct) {
  const p = Math.max(0, Math.min(100, healthPct));
  const red = hexToRgb(themeVarHex("--red", "#ff5f6d"));
  const yellow = hexToRgb(themeVarHex("--yellow", "#e6b450"));
  const green = hexToRgb(themeVarHex("--green", "#4fd18b"));
  const rgb = p <= 50 ? lerpRgb(red, yellow, p / 50) : lerpRgb(yellow, green, (p - 50) / 50);
  return rgbToHex(rgb);
}
function withAlpha(hex, alpha) {
  return hex + Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
}

// conky 风格的分段配色——不是连续渐变，是固定色阶，每 10% 一档，5% 以下和
// 85% 以上单独加两档（更红/更绿），色值本身写死、够鲜艳，不跟主题变量走
// （这是专门给"单次额度剩余百分比"这一个进度条用的，跟别的额度条用的连续
// 渐变 healthColor() 是两套独立的配色逻辑，按需求只用在这一个地方）。
const CONKY_STEPS = [
  [5, "#d90000"], // <5%：很红
  [10, "#ff4d3d"], // ~10%：微红
  [20, "#ff7a3d"],
  [30, "#ff9f3d"],
  [40, "#ffc93d"],
  [50, "#e9e64a"],
  [60, "#c3e64a"],
  [70, "#8fdb4a"],
  [85, "#4fd15f"],
  [100, "#00e05a"], // 85-100%：很绿
];
function conkyStepColor(pct) {
  const p = Math.max(0, Math.min(100, pct));
  for (const [ceiling, color] of CONKY_STEPS) {
    if (p <= ceiling) return color;
  }
  return CONKY_STEPS[CONKY_STEPS.length - 1][1];
}

// 额度进度条的配色方案：原本是写死的两套——"剩余"用 conky 分段色阶、"已用"用连续
// 渐变。有人更喜欢一眼分档的红黄绿，也有人不想让进度条抢视线（单色）。做成一个可选
// 项存在本浏览器里，纯展示，不影响任何数据。
const USAGE_SCHEME_KEY = "cc_monitor_usage_scheme";

// 配色方案 = 一组锚点颜色，按"健康度"（0=最危险 100=最健康）在锚点之间插值。
// 原来那几个方案全是红黄绿一个色系，看着差不多；这里补上蓝青/紫粉/日落/森林/灰度/
// 光谱这些真正不同色系的，换一个能明显看出来。锚点从左到右 = 从最危险到最健康。
const USAGE_PALETTES = {
  health: ["#d90000", "#e6b450", "#10c378"], // 红 → 黄 → 绿（经典）
  ocean: ["#1e3a8a", "#0ea5e9", "#67e8f9"], // 深蓝 → 天蓝 → 青
  neon: ["#6d28d9", "#d946ef", "#f9a8d4"], // 紫 → 品红 → 粉
  sunset: ["#7f1d1d", "#f97316", "#fbbf24"], // 暗红 → 橙 → 琥珀
  forest: ["#14532d", "#16a34a", "#bef264"], // 深绿 → 绿 → 黄绿
  mono: ["#3f3f46", "#a1a1aa", "#e4e4e7"], // 灰度：完全不抢视线
};

function lerpPalette(anchors, pct) {
  const p = Math.max(0, Math.min(100, pct));
  const pos = (p / 100) * (anchors.length - 1);
  const i = Math.min(anchors.length - 2, Math.floor(pos));
  const a = hexToRgb(anchors[i]);
  const b = hexToRgb(anchors[i + 1]);
  if (!a || !b) return anchors[anchors.length - 1];
  return rgbToHex(lerpRgb(a, b, pos - i));
}

// 光谱：直接按健康度转色相（0=红 → 120=绿 → 200=青），饱和度拉满，跟上面几套
// "在两三个锚点之间插值"的做法完全不同，色彩跨度最大。
function spectrumColor(pct) {
  const p = Math.max(0, Math.min(100, pct));
  const hue = (p / 100) * 200; // 0(红) → 200(青蓝)
  const s = 0.72;
  const l = 0.48;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(hue / 60);
  const rgb = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
  ][Math.min(3, seg)];
  return rgbToHex(rgb.map((v) => (v + m) * 255));
}

const USAGE_SCHEMES = ["default", "steps", "traffic", "ocean", "neon", "sunset", "forest", "spectrum", "mono", "accent"];
let usageScheme = "default";
try {
  const saved = localStorage.getItem(USAGE_SCHEME_KEY);
  if (saved && USAGE_SCHEMES.includes(saved)) usageScheme = saved;
} catch (e) {
  // 隐私模式/禁用站点数据：用默认方案
}

// healthPct 是"健康度"（0=最危险 100=最健康），不是已用百分比——两种卡片的数字含义
// 不同（剩余 vs 已用），但颜色一律按健康度算，见 usageCard 里的换算。
function usageBarColor(healthPct, isSession) {
  const p = Math.max(0, Math.min(100, healthPct));
  switch (usageScheme) {
    case "steps":
      return conkyStepColor(p);
    case "traffic":
      return themeVarHex(p <= 10 ? "--red" : p <= 30 ? "--yellow" : "--green", "#4fd18b");
    case "spectrum":
      return spectrumColor(p);
    case "accent":
      return themeVarHex("--accent", "#4f8cff");
    case "ocean":
    case "neon":
    case "sunset":
    case "forest":
    case "mono":
      return lerpPalette(USAGE_PALETTES[usageScheme], p);
    default:
      // 保持原来的行为：单次额度（剩余）分段色阶，其它（已用）连续渐变
      return isSession ? conkyStepColor(p) : healthColor(p);
  }
}

function syncUsageSchemeSelects() {
  document.querySelectorAll(".usage-scheme-select").forEach((sel) => {
    sel.value = usageScheme;
  });
}

function setUsageScheme(value) {
  if (!USAGE_SCHEMES.includes(value)) return;
  usageScheme = value;
  try {
    localStorage.setItem(USAGE_SCHEME_KEY, value);
  } catch (e) {
    // 存不下就只在本次会话生效
  }
  syncUsageSchemeSelects();
  // 两块额度面板重画一遍（接口服务端有 180s 缓存，这里再请求一次很便宜）
  refreshUsageBoard();
  refreshHomeAnthropicInfo();
}

document.addEventListener("change", (ev) => {
  const sel = ev.target.closest(".usage-scheme-select");
  if (sel) setUsageScheme(sel.value);
});

// optional=true 的额度（按模型的 Sonnet/Opus 周额度）：接口没返回这个桶就整张卡不画——
// 不是每个账号都有这两项（比如只有 Fable 限额的账号），画一张"-"只会让人以为出了错。
// 单次额度和全模型周额度不是可选的：没数据也要占位，提示"这里本该有东西"。
function usageCard(label, bucket, windowMs, optional = false) {
  if (!bucket || bucket.utilization === null) {
    if (optional) return "";
    return `<div class="card"><div class="card-num">-</div><div class="card-label">${label}</div></div>`;
  }
  // resets_at 已经是过去的时间点，说明这个窗口已经到期滚动了、只是还没有新请求让接口
  // 刷新数字——接口这时候仍会把上一个窗口末尾的用量（比如刚好用满的 100%）原样返回，
  // 按它算"剩余"就是 0%，跟实际（新窗口、什么都还没用）完全相反。到期的窗口按 0 已用
  // 处理；另外把用量夹在 0~100 之间，接口偶尔给超过 100 的值也不会算出负的剩余。
  const windowExpired = bucket.resetsAt && new Date(bucket.resetsAt).getTime() < Date.now();
  const usedPct = windowExpired ? 0 : Math.max(0, Math.min(100, Math.round(bucket.utilization)));
  const isSession = windowMs === SESSION_WINDOW_MS;
  const accent = usedPct >= 90 ? "accent-red" : usedPct >= 70 ? "accent-yellow" : "";
  // 单次额度（session）显示"剩余百分比"，剩得越多越健康；其它额度依旧显示"已使用
  // 百分比"，但颜色统一换算成"健康度"（剩余越多越绿）——数字含义不同，颜色逻辑一致。
  const displayPct = isSession ? 100 - usedPct : usedPct;
  const healthPct = isSession ? displayPct : 100 - usedPct;
  const barColor = usageBarColor(healthPct, isSession);
  const barColorLight = rgbToHex(lerpRgb(hexToRgb(barColor), [255, 255, 255], 0.6));
  let hourglass = "";
  if (bucket.resetsAt && windowMs) {
    const msLeft = new Date(bucket.resetsAt).getTime() - Date.now();
    if (!Number.isNaN(msLeft)) {
      const elapsed = 1 - Math.max(0, Math.min(1, msLeft / windowMs));
      hourglass = `<span class="hourglass-wrap" title="${t("status.usage.windowElapsed", { pct: Math.round(elapsed * 100) })}">${hourglassSvg(elapsed, barColor)}</span>`;
    }
  }
  return `
    <div class="card ${accent}">
      <div class="card-num" style="color:${barColor}">${displayPct}%</div>
      <div class="neon-bar neon-bar-lg" style="border:1px solid ${barColor}; box-shadow:0 0 10px ${withAlpha(barColor, 0.55)};">
        <div class="neon-bar-fill" style="width:${displayPct}%; background:linear-gradient(90deg, ${barColorLight}, ${barColor});"></div>
      </div>
      <div class="card-label">
        <div>${t(isSession ? "status.usage.remainingLabel" : "status.usage.usedLabel")} · ${label}</div>
        ${bucket.resetsAt ? `<div class="reset-row">${hourglass}<span>${t("status.usage.resetLabel")}: ${fmtResetAt(bucket.resetsAt)}</span></div>` : ""}
      </div>
    </div>`;
}

async function refreshUsageBoard() {
  const result = await api("/api/usage");
  const el = document.getElementById("usage-board");
  if (!result) return;
  if (result.error) {
    el.innerHTML = `<div class="empty-state">${t("status.usageError", { msg: escapeHtml(result.error) })}</div>`;
    return;
  }
  const d = result.data;
  el.innerHTML = [
    usageCard(t("status.usage.session"), d.session, SESSION_WINDOW_MS),
    usageCard(t("status.usage.weekly"), d.weekly, WEEKLY_WINDOW_MS),
    usageCard(t("status.usage.weeklySonnet"), d.weeklySonnet, WEEKLY_WINDOW_MS, true),
    usageCard(t("status.usage.weeklyOpus"), d.weeklyOpus, WEEKLY_WINDOW_MS, true),
    ...perModelWeeklyCards(d),
  ].join("");
}

// 有些模型（目前观察到的是 Fable）没有专门的顶层字段，只在 limits[] 里挂一条按模型
// 限额的记录——usage.js 已经把它摘出来放进 perModelWeekly 数组，这里按数组长度动态
// 生成对应数量的卡片，不写死具体模型名。
function perModelWeeklyCards(d) {
  return (d.perModelWeekly || []).map((m) => usageCard(t("status.usage.weeklyModel", { model: m.model }), m, WEEKLY_WINDOW_MS));
}

// ---------- 首页：Anthropic 账号信息（用量四件套 + limits 明细 + spend） ----------
const SEVERITY_COLOR = { normal: "var(--green)", warning: "var(--yellow)", critical: "var(--red)" };
function severityLabel(sev) {
  return t("home.anthropicAccount.severity." + sev) || sev || "-";
}
function limitKindLabel(kind) {
  return t("home.anthropicAccount.limitKind." + kind) || kind || "-";
}

const SEVERITY_BAR_CLASS = { normal: "sev-normal", warning: "sev-warning", critical: "sev-critical", purple: "sev-purple" };
// 选了非默认配色方案时，"已使用百分比"和"重置时间"这两种进度条也跟着走同一套颜色，
// 否则页面上一半条是方案色、一半还是老的 severity 色，看着是两套东西。默认方案下
// 保持原样（按 severity 上色），"级别"那一列本来就在说正常/警告/严重，不重复。
function usageBarOverride(healthPct) {
  return usageScheme === "default" ? null : usageBarColor(healthPct, false);
}

function neonPercentBar(percent, severity, big, colorOverride) {
  if (percent === null || percent === undefined) return "-";
  const pct = Math.max(0, Math.min(100, percent));
  if (!colorOverride) {
    const sevClass = SEVERITY_BAR_CLASS[severity] || "sev-normal";
    return `
    <div class="neon-bar ${sevClass}${big ? " neon-bar-lg" : ""}">
      <div class="neon-bar-fill" style="width:${pct}%"></div>
    </div>
    <span class="neon-bar-pct">${percent}%</span>`;
  }
  const light = rgbToHex(lerpRgb(hexToRgb(colorOverride) || [128, 128, 128], [255, 255, 255], 0.6));
  return `
    <div class="neon-bar${big ? " neon-bar-lg" : ""}" style="border:1px solid ${colorOverride}; box-shadow:0 0 6px ${withAlpha(
    colorOverride,
    0.45
  )};">
      <div class="neon-bar-fill" style="width:${pct}%; background:linear-gradient(90deg, ${light}, ${colorOverride});"></div>
    </div>
    <span class="neon-bar-pct" style="color:${colorOverride};">${percent}%</span>`;
}

// 重置时间那一栏配的"这个窗口已经过去多少"紫色进度条——跟额度百分比不是一回事，
// kind=session 用 5 小时窗口，其它（weekly_all/weekly_scoped）用 7 天窗口。
function limitElapsedBar(resetsAt, kind) {
  if (!resetsAt) return "";
  const windowMs = kind === "session" ? SESSION_WINDOW_MS : WEEKLY_WINDOW_MS;
  const msLeft = new Date(resetsAt).getTime() - Date.now();
  if (Number.isNaN(msLeft)) return "";
  const elapsed = Math.round((1 - Math.max(0, Math.min(1, msLeft / windowMs))) * 100);
  return `<div class="neon-bar-cell" style="margin-top:4px;">${neonPercentBar(elapsed, "purple", false, usageBarOverride(100 - elapsed))}</div>`;
}

function fmtAccountDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString();
  } catch (e) {
    return iso;
  }
}

let accountInfoCache = null;
async function fetchAccountInfo() {
  accountInfoCache = await api("/api/account");
  return accountInfoCache;
}

// 账号信息打码开关：截图/录屏/结对编程的时候，姓名、邮箱、组织、套餐、计费方式这些
// 一眼就能认出人的字段不该跟着一起曝出去（这个项目自己就在提交历史里踩过这个坑）。
// 只影响本浏览器的显示，不改接口返回、不动任何数据；额度百分比不打码，那不是隐私。
const ACCOUNT_MASK_KEY = "cc_monitor_mask_account";
const ACCOUNT_MASK_TEXT = "***";
let accountMasked = false;
try {
  accountMasked = localStorage.getItem(ACCOUNT_MASK_KEY) === "1";
} catch (e) {
  // 隐私模式/禁用了站点数据：当成没开，不影响页面工作
}

function syncAccountMaskBtns() {
  document.querySelectorAll(".account-mask-btn").forEach((btn) => {
    btn.textContent = t(accountMasked ? "home.account.unmask" : "home.account.mask");
    btn.classList.toggle("active", accountMasked);
  });
}

function toggleAccountMask() {
  accountMasked = !accountMasked;
  try {
    localStorage.setItem(ACCOUNT_MASK_KEY, accountMasked ? "1" : "0");
  } catch (e) {
    // 存不下就只在本次会话生效
  }
  syncAccountMaskBtns();
  // 用缓存里的账号信息就地重画，不用再打一次接口
  renderAccountProfileInto("anthropic-profile-box", "anthropic-profile-info", accountInfoCache);
  renderAccountProfileInto("status-profile-box", "status-profile-info", accountInfoCache);
}

document.addEventListener("click", (ev) => {
  if (ev.target.closest(".account-mask-btn")) toggleAccountMask();
});

// 下钻列表里的"文件夹 · session · 完整路径"这一行：三段各自上色，长列表里扫起来
// 比一整行灰字快得多。sessionId 字段名在不同接口里有 sessionId / session_id 两种写法，
// 这里一并兼容。
function sessionCwdLine(r) {
  const sid = r.sessionId || r.session_id || "";
  const cwd = r.cwd || "";
  const head = sid
    ? `<span class="folder">${escapeHtml(folderName(cwd))}</span><span class="sep"> · </span><span class="sid">${escapeHtml(
        sid.slice(0, 8)
      )}…</span><span class="sep"> · </span>`
    : "";
  return `${head}<span class="path">${escapeHtml(cwd)}</span>`;
}

function renderAccountProfileInto(boxId, listId, info) {
  const box = document.getElementById(boxId);
  const list = document.getElementById(listId);
  if (!box || !list) return;
  if (!info || (!info.email && !info.displayName)) {
    box.hidden = true;
    return;
  }
  // 打码只作用于能指认到具体某个人的三项：姓名、邮箱、组织名。截图和录屏的实际
  // 需求是"别让人看出这是谁的号"，而不是把整块面板糊掉——套餐类型、额度档位、
  // 计费方式、账号/订阅创建时间这些是账号属性不是身份，糊掉之后这块面板就没有
  // 展示价值了。打码时统一显示成 ***，连原值长度都不泄露。
  const mask = (text) => (accountMasked ? ACCOUNT_MASK_TEXT : escapeHtml(text));
  const plain = (text) => escapeHtml(text);
  // 标识符很长（UUID 36 位、machineID/userID 64 位十六进制），这一列只有 266px 放不下，
  // 截成"头 8 … 尾 4"，完整值放进 title 供悬停查看。打码时 title 也必须一起打码，
  // 否则遮了正文却能悬停看到原值，等于没遮。
  const ident = (text) => {
    if (accountMasked) return ACCOUNT_MASK_TEXT;
    const v = String(text);
    const short = v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
    return `<span title="${escapeHtml(v)}" class="ident-val">${escapeHtml(short)}</span>`;
  };
  const rows = [];
  if (info.displayName) rows.push({ label: t("home.anthropicAccount.profile.name"), value: mask(info.displayName) });
  if (info.email) rows.push({ label: t("home.anthropicAccount.profile.email"), value: mask(info.email) });
  if (info.organizationName) rows.push({ label: t("home.anthropicAccount.profile.org"), value: mask(info.organizationName) });
  if (info.organizationRole) rows.push({ label: t("home.anthropicAccount.profile.role"), value: plain(info.organizationRole) });
  if (info.organizationType) rows.push({ label: t("home.anthropicAccount.profile.plan"), value: plain(info.organizationType) });
  if (info.organizationRateLimitTier) rows.push({ label: t("home.anthropicAccount.profile.rateLimitTier"), value: plain(info.organizationRateLimitTier) });
  if (info.billingType) rows.push({ label: t("home.anthropicAccount.profile.billing"), value: plain(info.billingType) });
  const createdAt = fmtAccountDate(info.accountCreatedAt);
  if (createdAt) rows.push({ label: t("home.anthropicAccount.profile.createdAt"), value: plain(createdAt) });
  const subCreatedAt = fmtAccountDate(info.subscriptionCreatedAt);
  if (subCreatedAt) rows.push({ label: t("home.anthropicAccount.profile.subCreatedAt"), value: plain(subCreatedAt) });
  // 标识符：默认显示，跟着"隐藏敏感信息"一起打码。
  if (info.accountUuid) rows.push({ label: t("home.anthropicAccount.profile.accountUuid"), value: ident(info.accountUuid) });
  if (info.organizationUuid) rows.push({ label: t("home.anthropicAccount.profile.orgUuid"), value: ident(info.organizationUuid) });
  if (info.userID) rows.push({ label: t("home.anthropicAccount.profile.userId"), value: ident(info.userID) });
  if (info.machineID) rows.push({ label: t("home.anthropicAccount.profile.machineId"), value: ident(info.machineID) });
  // 本机的 Claude Code 状态，不是"账号是谁"。这几项一律明文——它们不是身份信息，
  // 而且正是排查 hook 失灵时要看的东西，遮掉没有意义。
  if (info.claudeCodeVersion) {
    const v = info.claudeCodeVersion;
    rows.push({
      label: t("home.anthropicAccount.profile.ccVersion"),
      value: plain(v.value) + (v.approx ? ` <span class="approx-tag" title="${t("home.anthropicAccount.profile.ccVersionApproxTip")}">${t("home.anthropicAccount.profile.approx")}</span>` : ""),
    });
  }
  if (info.installMethod) rows.push({ label: t("home.anthropicAccount.profile.installMethod"), value: plain(info.installMethod) });
  if (info.autoUpdates !== null && info.autoUpdates !== undefined) {
    rows.push({
      label: t("home.anthropicAccount.profile.autoUpdates"),
      value: plain(t(info.autoUpdates ? "common.on" : "common.off")),
    });
  }
  if (typeof info.mcpServerCount === "number") {
    const names = (info.mcpServerNames || []).join(", ");
    rows.push({
      label: t("home.anthropicAccount.profile.mcpServers"),
      value: names
        ? `<span title="${escapeHtml(names)}">${t("home.anthropicAccount.profile.mcpCount", { n: info.mcpServerCount })}</span>`
        : plain(t("home.anthropicAccount.profile.mcpCount", { n: info.mcpServerCount })),
    });
  }
  box.hidden = rows.length === 0;
  list.innerHTML = rows.map((r) => `<div class="bar-row"><span class="name">${r.label}</span><span>${r.value}</span></div>`).join("");
}

async function refreshAccountProfile() {
  const info = await fetchAccountInfo();
  renderAccountProfileInto("anthropic-profile-box", "anthropic-profile-info", info);
  renderAccountProfileInto("status-profile-box", "status-profile-info", info);
}

// 额度明细（limits）表格——首页和状态信息页各有一份 DOM（同一份数据渲染两次），
// 状态信息页那份用加长加粗的 neon-bar-lg，首页保留原来的小号版本。
function renderLimitsInto(box, list, limits) {
  if (!box || !list) return;
  if (!limits || limits.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const big = box.id === "status-limits-box";
  list.innerHTML = `
    <table class="dd-table">
      <thead><tr>
        <th>${t("home.anthropicAccount.limitKindCol")}</th><th>${t("home.anthropicAccount.percentCol")}</th>
        <th>${t("home.anthropicAccount.severityCol")}</th><th>${t("home.anthropicAccount.resetCol")}</th><th>${t("home.anthropicAccount.activeCol")}</th>
      </tr></thead>
      <tbody>
        ${limits
          .map(
            (l) => `
          <tr>
            <td>${escapeHtml(limitKindLabel(l.kind))}${l.scopeModel ? ` (${escapeHtml(l.scopeModel)})` : ""}</td>
            <!-- .neon-bar-cell 要包一层 div，不能直接扣在 <td> 上：display:flex 一旦
                 直接加在 <td> 上，这个单元格就不再随行内最高的兄弟单元格（"重置时间"
                 那一列带了两行内容，行高被撑高）一起拉伸到同样高度，百分比条就贴在
                 单元格顶部、下面多出一截空白，看起来跟同一行的其它列错位。 -->
            <td><div class="neon-bar-cell">${neonPercentBar(l.percent, l.severity, big, usageBarOverride(100 - (l.percent || 0)))}</div></td>
            <td><span style="color:${SEVERITY_COLOR[l.severity] || "var(--text-dim)"}">${escapeHtml(severityLabel(l.severity))}</span></td>
            <td class="dd-mono">${l.resetsAt ? fmtResetAt(l.resetsAt) : "-"}${limitElapsedBar(l.resetsAt, l.kind)}</td>
            <td>${l.isActive ? "●" : "-"}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

// 首页态势摘要条最右一张卡：单次额度剩余百分比 + 迷你 neon 条 + 重置倒计时。
// 跟下面账号区里那张大卡是同一份数据、同一套 conky 分段配色，只是尺寸缩小。
function renderStripUsage(bucket) {
  const el = document.getElementById("strip-usage");
  if (!el) return;
  const title = `<div class="strip-title">${t("home.strip.sessionQuota")}</div>`;
  if (!bucket || bucket.utilization === null) {
    el.innerHTML = `<div class="strip-num" style="color:var(--text-dim)">-</div><div class="strip-body">${title}<div class="strip-cap">${t("home.strip.quotaUnavailable")}</div></div>`;
    return;
  }
  const windowExpired = bucket.resetsAt && new Date(bucket.resetsAt).getTime() < Date.now();
  const usedPct = windowExpired ? 0 : Math.max(0, Math.min(100, Math.round(bucket.utilization)));
  const remaining = 100 - usedPct;
  const color = usageBarColor(remaining, true);
  const light = rgbToHex(lerpRgb(hexToRgb(color), [255, 255, 255], 0.6));
  const reset = bucket.resetsAt ? fmtResetAt(bucket.resetsAt).replace(/\s*\(.*\)$/, "") : "";
  el.innerHTML = `
    <div class="strip-num" style="color:${color}">${remaining}%</div>
    <div class="strip-body">
      ${title}
      <div class="neon-bar" style="border:1px solid ${color}; box-shadow:0 0 8px ${withAlpha(color, 0.45)};"><div class="neon-bar-fill" style="width:${remaining}%; background:linear-gradient(90deg, ${light}, ${color});"></div></div>
      ${reset ? `<div class="strip-cap">${t("home.strip.quotaReset", { when: reset })}</div>` : ""}
    </div>`;
}

async function refreshHomeAnthropicInfo() {
  await refreshAccountProfile();
  const result = await api("/api/usage");
  const cardsEl = document.getElementById("anthropic-usage-cards");
  const limitsBox = document.getElementById("anthropic-limits-box");
  const limitsList = document.getElementById("anthropic-limits-list");
  const spendBox = document.getElementById("anthropic-spend-box");
  const spendInfo = document.getElementById("anthropic-spend-info");
  if (!result) return;
  if (result.error) {
    cardsEl.innerHTML = `<div class="empty-state">${t("status.usageError", { msg: escapeHtml(result.error) })}</div>`;
    limitsBox.hidden = true;
    spendBox.hidden = true;
    renderStripUsage(null);
    return;
  }
  const d = result.data;
  renderStripUsage(d.session);
  cardsEl.innerHTML = [
    usageCard(t("status.usage.session"), d.session, SESSION_WINDOW_MS),
    usageCard(t("status.usage.weekly"), d.weekly, WEEKLY_WINDOW_MS),
    usageCard(t("status.usage.weeklySonnet"), d.weeklySonnet, WEEKLY_WINDOW_MS, true),
    usageCard(t("status.usage.weeklyOpus"), d.weeklyOpus, WEEKLY_WINDOW_MS, true),
    ...perModelWeeklyCards(d),
  ].join("");

  renderLimitsInto(limitsBox, limitsList, d.limits);
  renderLimitsInto(document.getElementById("status-limits-box"), document.getElementById("status-limits-list"), d.limits);

  if (d.spend) {
    spendBox.hidden = false;
    const s = d.spend;
    const rows = [];
    rows.push({ label: t("home.anthropicAccount.spendEnabled"), value: s.enabled ? t("home.anthropicAccount.yes") : t("home.anthropicAccount.no") });
    if (s.enabled) {
      const amount = s.usedAmountMinor !== null ? (s.usedAmountMinor / Math.pow(10, s.exponent)).toFixed(s.exponent) : "-";
      rows.push({ label: t("home.anthropicAccount.spendUsed"), value: `${amount} ${s.currency || ""}` });
      rows.push({ label: t("home.anthropicAccount.spendPercent"), value: s.percent === null ? "-" : s.percent + "%" });
      rows.push({ label: t("home.anthropicAccount.spendCanPurchase"), value: s.canPurchaseCredits ? t("home.anthropicAccount.yes") : t("home.anthropicAccount.no") });
    } else if (s.disabledReason) {
      rows.push({ label: t("home.anthropicAccount.spendDisabledReason"), value: escapeHtml(s.disabledReason) });
    }
    spendInfo.innerHTML = rows.map((r) => `<div class="bar-row"><span class="name">${escapeHtml(r.label)}</span><span>${r.value}</span></div>`).join("");
  } else {
    spendBox.hidden = true;
  }
  // 左边那个账号信息盒子：账号资料和 spend 两块都没内容（比如没登录凭证）就整个收起，
  // 不留一个空框。
  const accountCol = document.querySelector(".home-account .account-col");
  if (accountCol) accountCol.hidden = document.getElementById("anthropic-profile-box").hidden && spendBox.hidden;
}

// ---------- claude 进程运行身份检测 ----------
let identityLastResult = null;
async function refreshIdentityCard() {
  const result = await api("/api/claude-processes");
  if (!result) return;
  identityLastResult = result;
  document.getElementById("stat-identity-total").textContent = String(result.total);

  // "监测到的 Claude Code 会话总数"卡片上的迷你心跳徽章：只要有一个进程正处于
  // working 状态就露出来，给首页一个"现在有事情正在发生"的一眼信号；全都 idle/没有
  // 进程的时候完全不占地方（隐藏），不是每次都摆一个"死气沉沉"的图标出来。
  const vitalBadge = document.getElementById("stat-sessions-vital");
  if (vitalBadge) {
    const anyWorking = result.processes.some((p) => p.status === "working");
    vitalBadge.hidden = !anyWorking;
    vitalBadge.innerHTML = anyWorking ? renderVital("working", 0) : "";
  }

  const banner = document.getElementById("identity-mismatch-banner");
  if (result.mismatchedUsers.length > 0) {
    banner.hidden = false;
    banner.textContent = t("home.identity.mismatchWarning", {
      n: result.mismatchedUsers.reduce((sum, u) => sum + result.byUser[u], 0),
      users: result.mismatchedUsers.join(", "),
    });
  } else {
    banner.hidden = true;
  }

  const byUserEl = document.getElementById("identity-by-user");
  const users = Object.keys(result.byUser);
  if (users.length === 0) {
    byUserEl.innerHTML = "";
  } else {
    byUserEl.innerHTML = users
      .map((u) => {
        const isCurrent = u === result.currentUser;
        return `<div class="bar-row"><span class="name">${escapeHtml(u)}${isCurrent ? " " + t("home.identity.currentTag") : ""}</span><span>${result.byUser[u]}</span></div>`;
      })
      .join("");
  }
}

// ---------- Claude Code 网络流量 ----------
function formatBytes(n) {
  if (n === null || n === undefined) return "-";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

let networkMap = null;
function ensureNetworkMap() {
  if (networkMap || !window.NetworkWorldMap) return;
  const canvas = document.getElementById("network-map-canvas");
  networkMap = new NetworkWorldMap(canvas);
  if (!networkMap.ok) {
    document.getElementById("network-map-empty").hidden = false;
    document.getElementById("network-map-empty").textContent = t("network.mapNoWebgl");
    return;
  }
  networkMap.loadLand("/world.geo.json");
}

async function refreshNetworkTraffic() {
  const [trafficResult, geoResult] = await Promise.all([
    api(`/api/network-traffic?limit=200&lang=${currentLang}`),
    api(`/api/network-traffic/geopairs?limit=500&lang=${currentLang}`),
  ]);
  if (!trafficResult) return;

  const badge = document.getElementById("network-geo-badge");
  const geo = trafficResult.geo;
  if (geo.available) {
    badge.hidden = false;
    badge.className = "geo-acc-badge geo-acc-" + geo.accuracy;
    badge.textContent = geo.accuracy === "city" ? t("network.geoCity") : t("network.geoCountry");
    badge.title = geo.dbPath;
  } else {
    badge.hidden = false;
    badge.className = "geo-acc-badge geo-acc-none";
    badge.textContent = t("network.geoNone");
    badge.title = t("network.geoNoneHint");
  }

  const s = trafficResult.summary;
  document.getElementById("network-summary").innerHTML = `
    <div class="card dense"><div class="card-num">${formatBytes(s.txBytes)}</div><div class="card-label">${t("network.totalTx")}</div></div>
    <div class="card dense"><div class="card-num">${formatBytes(s.rxBytes)}</div><div class="card-label">${t("network.totalRx")}</div></div>
    <div class="card dense clickable" data-drilldown="ai-trajectory"><div class="card-num">${s.connectCount}</div><div class="card-label">${t("network.totalConnects")} <span class="click-hint">${t("home.card.clickHint")}</span></div></div>
    <div class="card dense clickable" data-drilldown="ai-trajectory"><div class="card-num">${s.distinctIps}</div><div class="card-label">${t("network.distinctIps")} <span class="click-hint">${t("home.card.clickHint")}</span></div></div>
  `;

  const rows = trafficResult.rows;
  const tableWrap = document.getElementById("network-table-wrap");
  if (rows.length === 0) {
    tableWrap.innerHTML = `<div class="empty-state">${t("network.empty")}</div>`;
  } else {
    tableWrap.innerHTML = `
      <table class="dd-table">
        <thead><tr>
          <th>${t("network.col.target")}</th><th>${t("network.col.location")}</th>
          <th>${t("network.col.tx")}</th><th>${t("network.col.rx")}</th>
          <th>${t("network.col.connects")}</th><th>${t("network.col.lastSeen")}</th>
        </tr></thead>
        <tbody>
          ${rows
            .map((r) => {
              const badge = r.inferred ? `<span class="dd-badge-inferred" title="${t("network.inferredHint")}">${t("network.inferredBadge")}</span> ` : "";
              const target = r.host ? `${badge}${escapeHtml(r.host)}<br><span class="dd-mono hint">${escapeHtml(r.ip)}${r.port ? ":" + r.port : ""}</span>` : `${badge}<span class="dd-mono">${escapeHtml(r.ip)}${r.port ? ":" + r.port : ""}</span>`;
              const countryLabel = r.geo ? r.geo.country || r.geo.countryCode : null;
              const loc = r.geo ? escapeHtml([r.geo.city, countryLabel].filter(Boolean).join(", ") || "-") : `<span class="hint">${t("network.noLocation")}</span>`;
              return `<tr>
                <td>${target}</td>
                <td>${loc}</td>
                <td>${formatBytes(r.txBytes)}</td>
                <td>${formatBytes(r.rxBytes)}</td>
                <td><span class="dd-open-hint" style="cursor:pointer;" data-target-ip="${escapeHtml(r.ip)}" data-target-port="${r.port}" data-target-host="${escapeHtml(r.host || "")}">${r.connectCount} ›</span></td>
                <td class="dd-mono">${escapeHtml((r.lastSeen || "").slice(0, 19))}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;
  }

  if (networkMap && networkMap.ok && geoResult) {
    document.getElementById("network-map-empty").hidden = geoResult.pairs.length > 0;
    if (geoResult.pairs.length === 0) document.getElementById("network-map-empty").textContent = t("network.mapEmpty");
    networkMap.setData(geoResult.pairs);
  }
}

// ---------- 启动 ----------
function refreshEverythingNow() {
  refreshSessionList();
  refreshLogSessionOptions();
  pollLogs();
  pollTap();
  refreshOverview();
  refreshStatusBoard();
  refreshModelUsage();
  refreshUsageBoard();
  refreshHomeAnthropicInfo();
  refreshTerminalStatusline();
  refreshAuditState();
  refreshRemoteAccessState();
  refreshApprovals();
  refreshApprovalHistory();
  refreshIdentityCard();
  refreshNetworkTraffic();
}

// 浏览器会把后台标签页的 setInterval 大幅节流（甚至几分钟才跑一次）来省电，
// 所以只靠定时轮询，标签页切到后台的这段时间里发生的新会话/新事件会一直显示
// "旧"的，直到下一次真正被节流放行的 tick。切回前台的瞬间强制刷新一次，
// 保证"看的时候"一定是最新的，不用等轮询节流器恢复正常节奏。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshEverythingNow();
});
window.addEventListener("focus", refreshEverythingNow);

// ---------- 语言 / 主题切换 ----------
document.getElementById("theme-select").addEventListener("change", (ev) => applyTheme(ev.target.value));

// ---------- 外观设置弹窗（主题色块 / 字体 / 字号） ----------
function buildThemeSwatchGrid() {
  const grid = document.getElementById("theme-swatch-grid");
  grid.innerHTML = THEMES.map(
    (theme) => `
    <button type="button" class="theme-swatch${theme === currentTheme ? " active" : ""}" data-theme="${theme}">
      <span class="swatch-dot" style="background:${THEME_ACCENT[theme]}"></span>
      ${t("theme." + theme)}
    </button>`
  ).join("");
  grid.querySelectorAll(".theme-swatch").forEach((btn) => {
    btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
  });
}

const settingsModal = document.getElementById("settings-modal");
document.getElementById("settings-btn").addEventListener("click", () => {
  buildThemeSwatchGrid();
  settingsModal.hidden = false;
});
document.getElementById("settings-close-btn").addEventListener("click", () => (settingsModal.hidden = true));
settingsModal.addEventListener("click", (ev) => {
  if (ev.target === settingsModal) settingsModal.hidden = true;
});
document.getElementById("font-family-select").addEventListener("change", (ev) => applyFont(ev.target.value));
document.getElementById("font-size-range").addEventListener("input", (ev) => applyFontSize(ev.target.value));
document.getElementById("settings-reset-btn").addEventListener("click", () => {
  applyTheme("brand");
  applyFont("system");
  applyFontSize(14);
  buildThemeSwatchGrid();
});
document.getElementById("lang-toggle-btn").addEventListener("click", () => {
  setLang(currentLang === "zh" ? "en" : "zh");
  syncGridToggleBtnText();
  syncApprovalsNotifyBtn();
  syncAccountMaskBtns();
  syncNewSessionModalText();
  setGpuState(gpuState);
  // 静态文案已经在 setLang -> applyStaticI18n 里刷新了；已经拼好 append 到列表里的
  // 日志/Tap 条目不会自动重新翻译（是已经生成的 DOM，不是"状态"），干脆清空重新拉一遍。
  lastLogId = 0;
  document.getElementById("log-list-full").innerHTML = "";
  tapNextLine = 0;
  document.getElementById("tap-list").innerHTML = "";
  refreshEverythingNow();
});

async function bootstrap() {
  applyTheme(currentTheme);
  applyFont(currentFont);
  applyFontSize(currentFontSize);
  applyStaticI18n();
  syncGridToggleBtnText();
  syncApprovalsNotifyBtn();
  syncAccountMaskBtns();
  syncUsageSchemeSelects();

  const initialSessions = await refreshSessionList();
  const lastId = getLastSession();
  if (lastId && (initialSessions || []).some((s) => s.id === lastId)) {
    selectSession(lastId);
  }
  await refreshAgents();
  {
    const wanted = (location.hash || "").slice(1);
    const btn = wanted && document.querySelector(`.tab-btn[data-tab="${CSS.escape(wanted)}"]`);
    if (btn && !btn.classList.contains("active")) btn.click();
  }
  await refreshLogSessionOptions();
  await pollLogs();
  await refreshOverview();
  await refreshStatusBoard();
  await refreshModelUsage();
  await refreshUsageBoard();
  await refreshHomeAnthropicInfo();
  await refreshAuditState();
  await refreshRemoteAccessState();
  await refreshApprovals();
  await refreshIdentityCard();

  setInterval(refreshSessionList, 4000);
  setInterval(refreshAgents, 15000);
  setInterval(refreshLogSessionOptions, 8000);
  setInterval(pollLogs, 1500);
  setInterval(pollTap, 2000);
  setInterval(refreshOverview, 5000);
  setInterval(refreshStatusBoard, 5000);
  setInterval(refreshUsageBoard, 30000); // 后端本身有 180s 缓存，前端更不用问太勤
  setInterval(refreshHomeAnthropicInfo, 30000);
  setInterval(refreshTerminalStatusline, 5000);
  setInterval(refreshAuditState, 5000);
  setInterval(refreshRemoteAccessState, 15000); // 安全相关但很少变，不用跟审计状态一样勤
  setInterval(refreshIdentityCard, 15000); // 进程身份也不会频繁变，跟远程访问开关一个节奏
  setInterval(refreshApprovals, 2000); // 这几个是卡着等结果的，轮询间隔比其它都短
  setInterval(refreshNetworkTraffic, 10000);
}
bootstrap();
