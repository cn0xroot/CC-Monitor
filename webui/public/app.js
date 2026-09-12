"use strict";

const RISK_COLOR = { high: "var(--red)", medium: "var(--yellow)", low: "var(--green)", info: "var(--cyan)", "-": "var(--text-dim)" };
const KNOWN_TOOLS = new Set([
  "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite",
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
const EXTRA_LABEL_MAP = { 结果: "extra.result", 输出: "extra.output" };
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

async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
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
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("view-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "terminal") {
      setTimeout(() => {
        fitAddon.fit();
        for (const pane of gridPanes.values()) pane.fitAddon.fit();
      }, 30);
    }
    if (btn.dataset.tab === "archives") refreshArchivesList();
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
    el.innerHTML = `
      <div class="cwd">${escapeHtml(s.cwd)}</div>
      <div class="meta">
        <span>${new Date(s.createdAt).toLocaleTimeString()} ${s.alive ? "" : t("terminal.exited")}</span>
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

document.getElementById("new-session-btn").addEventListener("click", () => {
  newSessionCwdInput.value = "";
  newSessionModal.hidden = false;
  newSessionCwdInput.focus();
});
document.getElementById("new-session-cancel").addEventListener("click", () => {
  newSessionModal.hidden = true;
});
newSessionModal.addEventListener("click", (ev) => {
  if (ev.target === newSessionModal) newSessionModal.hidden = true; // 点击背景关闭
});
async function createSessionFromModal() {
  const cwd = newSessionCwdInput.value.trim();
  newSessionModal.hidden = true;
  const session = await api("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: cwd || undefined }),
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
      opt.textContent = sessionLabel(r) + flag;
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
// localStorage 里，跟语言/主题一个存法。Log 审计和 Claude Tap 各有一个独立开关。
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
      <span class="label op-${opCategory}">${escapeHtml(toolLabel(ev.toolName, ev.label))}</span>
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

// ---------- Claude Tap：发给/收到模型的完整对话内容 ----------
const tapSelect = document.getElementById("tap-session-select");
const tapMeta = document.getElementById("tap-meta");
let tapNextLine = 0;
let tapKnownSessions = [];

function refreshTapSessionOptions(rows) {
  tapKnownSessions = rows;
  // 同样的道理：下拉框正被用户操作（focus 在它上面）的时候不要重建 <option>，
  // 不然选项会在他们眼皮底下被"刷新掉"——这正是这个开关要修的那个 bug。
  if (document.activeElement === tapSelect) return;
  const current = tapSelect.value;
  tapSelect.innerHTML = `<option value="">${t("tap.selectPlaceholder")}</option>`;
  for (const r of rows) {
    const opt = document.createElement("option");
    opt.value = r.session_id;
    opt.textContent = sessionLabel(r) + (r.has_transcript ? "" : t("tap.noTranscript"));
    opt.disabled = !r.has_transcript;
    opt.title = `${r.cwd || ""}\nID: ${r.session_id}`;
    tapSelect.appendChild(opt);
  }
  if (current && rows.some((r) => r.session_id === current)) tapSelect.value = current;
}

tapSelect.addEventListener("change", () => {
  tapNextLine = 0;
  document.getElementById("tap-list").innerHTML = "";
  tapMeta.textContent = "";
  if (tapSelect.value) pollTap();
});

function renderTapEntry(entry) {
  const el = document.createElement("div");
  el.className = "tap-entry tap-kind-" + entry.kind;
  const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : "";
  el.innerHTML = `
    <div class="tap-header">
      <span class="tap-role tap-role-${entry.kind}">${escapeHtml(t("tap.kind." + entry.kind))}</span>
      <span class="tap-ts">${ts}</span>
      ${entry.usageHtml || ""}
    </div>
    ${entry.blocksHtml || ""}
  `;
  return el;
}

async function pollTap() {
  const sessionId = tapSelect.value;
  if (!sessionId) return;
  const params = new URLSearchParams({ session_id: sessionId, since_line: String(tapNextLine), limit: "300" });
  const result = await api("/api/transcript?" + params.toString());
  if (!result) return;
  tapNextLine = result.nextLine;
  const list = document.getElementById("tap-list");
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

// ---------- 首页概览 ----------
async function refreshOverview() {
  const s = await api("/api/overview");
  if (!s) return;
  document.getElementById("stat-live-sessions").textContent = s.liveSessionCount;
  document.getElementById("stat-total-sessions").textContent = s.sessionCount;
  document.getElementById("stat-total-events").textContent = s.total;
  document.getElementById("stat-blocked").textContent = s.blockedTotal;
  document.getElementById("stat-bypass").textContent = s.bypassTotal;

  if (s.fileOps) {
    document.getElementById("stat-file-reads").textContent = s.fileOps.reads;
    document.getElementById("stat-file-writes").textContent = s.fileOps.writes;
    document.getElementById("stat-file-edits").textContent = s.fileOps.edits;
    document.getElementById("stat-file-deletes").textContent = s.fileOps.deletes;
  }

  renderBarList("source-breakdown", s.bySource.map((r) => ({
    name: sourceLabel2(r.source) || r.source || "-",
    count: r.n,
    color: "var(--accent)",
  })));
  renderBarList("risk-breakdown", s.byRisk.map((r) => ({
    name: riskLabel(r.risk) || r.risk || "-",
    count: r.n,
    color: RISK_COLOR[r.risk] || "var(--text-dim)",
  })));
}

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

// ---------- 审计开关：开始/暂停合并成一个切换按钮 + 单独的停止按钮 ----------
// 开始和暂停是同一件事的两个方向（"现在要不要拦截"），做成一个按钮来回切换；
// 停止是完全不同性质的动作（连记录都不留了），单独放一个按钮，不跟前面那个混在一起。
const auditToggleBtn = document.getElementById("audit-toggle-btn");
function applyAuditState(state) {
  document.getElementById("audit-state-pill").className = "pill audit-state-" + state;
  document.getElementById("audit-state-text").textContent = t("auditState." + state);

  if (state === "running") {
    auditToggleBtn.textContent = t("home.auditCtl.pause");
    auditToggleBtn.className = "btn-secondary audit-btn-pause active";
    auditToggleBtn.dataset.nextState = "paused";
  } else {
    auditToggleBtn.textContent = t("home.auditCtl.start");
    auditToggleBtn.className = "btn-secondary audit-btn-start active";
    auditToggleBtn.dataset.nextState = "running";
  }
  document.getElementById("audit-stop-btn").classList.toggle("active", state === "stopped");
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
auditToggleBtn.addEventListener("click", () => setAuditState(auditToggleBtn.dataset.nextState));
document.getElementById("audit-stop-btn").addEventListener("click", async () => {
  const ok = await confirmDialog(t("modal.stopAudit.title"), t("modal.stopAudit.body"));
  if (!ok) return;
  setAuditState("stopped");
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

// 打开一份历史归档，翻看里面具体记录了哪些事件——复用首页下钻详情那个弹窗，
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

async function openDrilldown(kind) {
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
          <th>${t("drilldown.liveSessions.cwd")}</th><th>${t("drilldown.liveSessions.status")}</th>
          <th>${t("drilldown.liveSessions.uptime")}</th><th>${t("drilldown.liveSessions.clients")}</th>
          <th>${t("drilldown.liveSessions.model")}</th><th>${t("drilldown.liveSessions.events")}</th><th></th>
        </tr></thead>
        <tbody>
          ${rows
            .map(
              (s) => `
            <tr class="dd-row-clickable" data-id="${escapeHtml(s.id)}">
              <td>${escapeHtml(s.cwd || "-")}</td>
              <td>${s.alive ? escapeHtml(t("terminal.running")) : escapeHtml(t("terminal.stopped"))}</td>
              <td class="dd-mono">${formatUptime(Date.now() - s.createdAt)}</td>
              <td>${s.clientCount}</td>
              <td>${escapeHtml(modelShort(s.model) || "-")}</td>
              <td>${s.eventCount === null || s.eventCount === undefined ? "-" : s.eventCount}</td>
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
          <th>${t("drilldown.sessions.model")}</th><th>${t("drilldown.sessions.events")}</th>
          <th>${t("drilldown.sessions.flags")}</th><th>${t("drilldown.sessions.range")}</th>
        </tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr>
              <td>${escapeHtml(r.cwd || "-")}</td>
              <td class="dd-mono">${escapeHtml(r.sessionId)}</td>
              <td>${escapeHtml(modelShort(r.model) || "-")}</td>
              <td>${r.eventCount}</td>
              <td>${r.blockedCount > 0 ? `🛑${r.blockedCount} ` : ""}${r.bypassCount > 0 ? `⚠${r.bypassCount}` : ""}${
                r.blockedCount === 0 && r.bypassCount === 0 ? "-" : ""
              }</td>
              <td class="dd-mono">${(r.firstTs || "").slice(0, 19)} ~ ${(r.lastTs || "").slice(11, 19)}</td>
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

  if (kind === "blocked") {
    title.textContent = t("drilldown.blocked.title");
    const rows = await api("/api/drilldown/blocked");
    if (!rows) return;
    if (rows.length === 0) {
      body.innerHTML = `<div class="empty-state">${t("drilldown.blocked.empty")}</div>`;
      return;
    }
    body.innerHTML = rows
      .map(
        (r) => `
      <div class="log-item">
        <div class="row1">
          <span class="ts">${r.ts}</span>
          <span class="risk high">${escapeHtml(riskLabel("high"))}</span>
          <span class="label">${escapeHtml(toolLabel(r.toolName, r.label))}</span>
          <span class="decision blocked">${escapeHtml(decisionLabel("blocked"))}</span>
        </div>
        <div class="cwd">${r.sessionId ? folderName(r.cwd) + " · " + r.sessionId.slice(0, 8) + "… · " : ""}${escapeHtml(r.cwd || "")} · ${escapeHtml(
          r.matchedRule || "-"
        )}</div>
        <div class="summary">${r.summaryHtml || ""}</div>
      </div>`
      )
      .join("");
    return;
  }

  if (kind.startsWith("file-op-")) {
    const opType = kind.slice("file-op-".length); // read | write | edit | delete
    const opLabelKey = { read: "home.fileOps.reads", write: "home.fileOps.writes", edit: "home.fileOps.edits", delete: "home.fileOps.deletes" }[opType];
    title.textContent = t(opLabelKey) + " — " + t("drilldown.fileOp.suffix");
    const rows = await api("/api/drilldown/file-op/" + opType);
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
          <span class="label">${escapeHtml(toolLabel(r.toolName, r.label))}</span>
        </div>
        <div class="cwd">${r.sessionId ? folderName(r.cwd) + " · " + r.sessionId.slice(0, 8) + "… · " : ""}${escapeHtml(r.cwd || "")}</div>
        <div class="summary">${r.summaryHtml || ""}</div>
      </div>`
      )
      .join("");
    return;
  }
}

document.querySelectorAll(".card.clickable").forEach((card) => {
  card.addEventListener("click", () => openDrilldown(card.dataset.drilldown));
});

// ---------- 状态信息页（类 ccstatusline） ----------
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
        <span class="seg ${s.alive ? "alive" : "dead"}">${s.alive ? t("terminal.running") : t("terminal.stopped")}</span>
        <span class="seg cwd">📁 ${escapeHtml(s.cwd)}</span>
        ${s.gitBranch ? `<span class="seg branch${s.gitDirty ? " dirty" : ""}">⎇ ${escapeHtml(s.gitBranch)}</span>` : ""}
        <span class="seg">⏱ ${mins < 1 ? t("terminal.justNow") : t("terminal.minutesAgo", { n: mins })}</span>
      </div>`);
  }

  for (const s of auditSessions) {
    const ts = s.tokenStats;
    let tokenSegs = "";
    if (ts) {
      const rate = ts.outputTokensPerSec != null ? `${ts.outputTokensPerSec.toFixed(1)} tok/s ↑` : "";
      const rateIn = ts.inputTokensPerSec != null ? `${ts.inputTokensPerSec.toFixed(1)} tok/s ↓` : "";
      tokenSegs = `
        <span class="seg">💬 in=${ts.totalInputTokens} out=${ts.totalOutputTokens}${ts.totalCacheReadTokens ? ` cache=${ts.totalCacheReadTokens}` : ""}</span>
        ${rate ? `<span class="seg">⚡ ${rate}${rateIn ? " · " + rateIn : ""}</span>` : ""}
      `;
    }
    rows.push(`
      <div class="status-row">
        <span class="seg kind">🤖 ${folderName(s.cwd)} · ${s.sessionId.slice(0, 8)}…</span>
        ${s.model ? `<span class="seg model">🧠 ${escapeHtml(modelShort(s.model))}</span>` : ""}
        <span class="seg cwd">📁 ${escapeHtml(s.cwd || "-")}</span>
        ${s.gitBranch ? `<span class="seg branch${s.gitDirty ? " dirty" : ""}">⎇ ${escapeHtml(s.gitBranch)}</span>` : ""}
        <span class="seg">⏱ ${fmtDuration(s.firstTs, s.lastTs)}</span>
        <span class="seg">${t("status.eventCount", { n: s.eventCount })}</span>
        ${tokenSegs}
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
    const diffMs = d.getTime() - Date.now();
    const hours = diffMs / 3600000;
    const when = hours < 48 ? t("status.hoursLater", { n: Math.max(0, Math.round(hours)) }) : t("status.daysLater", { n: Math.round(hours / 24) });
    return `${when} (${d.toLocaleString()})`;
  } catch (e) {
    return iso;
  }
}

function usageCard(label, bucket) {
  if (!bucket || bucket.utilization === null) {
    return `<div class="card"><div class="card-num">-</div><div class="card-label">${label}</div></div>`;
  }
  const pct = Math.round(bucket.utilization);
  const accent = pct >= 90 ? "accent-red" : pct >= 70 ? "accent-yellow" : "";
  return `
    <div class="card ${accent}">
      <div class="card-num">${pct}%</div>
      <div class="card-label">${label}<br>${bucket.resetsAt ? t("status.usage.resetLabel") + ": " + fmtResetAt(bucket.resetsAt) : ""}</div>
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
    usageCard(t("status.usage.session"), d.session),
    usageCard(t("status.usage.weekly"), d.weekly),
    usageCard(t("status.usage.weeklySonnet"), d.weeklySonnet),
    usageCard(t("status.usage.weeklyOpus"), d.weeklyOpus),
  ].join("");
}

// ---------- 启动 ----------
function refreshEverythingNow() {
  refreshSessionList();
  refreshLogSessionOptions();
  pollLogs();
  pollTap();
  refreshOverview();
  refreshStatusBoard();
  refreshUsageBoard();
  refreshTerminalStatusline();
  refreshAuditState();
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
document.getElementById("lang-toggle-btn").addEventListener("click", () => {
  setLang(currentLang === "zh" ? "en" : "zh");
  syncGridToggleBtnText();
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
  applyStaticI18n();
  syncGridToggleBtnText();

  await refreshSessionList();
  await refreshLogSessionOptions();
  await pollLogs();
  await refreshOverview();
  await refreshStatusBoard();
  await refreshUsageBoard();
  await refreshAuditState();

  setInterval(refreshSessionList, 4000);
  setInterval(refreshLogSessionOptions, 8000);
  setInterval(pollLogs, 1500);
  setInterval(pollTap, 2000);
  setInterval(refreshOverview, 5000);
  setInterval(refreshStatusBoard, 5000);
  setInterval(refreshUsageBoard, 30000); // 后端本身有 180s 缓存，前端更不用问太勤
  setInterval(refreshTerminalStatusline, 5000);
  setInterval(refreshAuditState, 5000);
}
bootstrap();
