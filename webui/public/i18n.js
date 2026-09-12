"use strict";
// 界面文案的中英字典。注意范围：只翻译"界面文案"（导航、按钮、标题、空状态提示等），
// 不翻译"数据"——命令文本、工具输出、transcript 对话原文这些内容本来是什么语言就是什么语言，
// 切换界面语言不会去改写它们。

const I18N = {
  zh: {
    "brand.title": "CC-Monitor",
    "nav.home": "首页",
    "nav.logs": "Log 审计",
    "nav.terminal": "终端会话",
    "nav.tap": "Claude Tap",
    "nav.status": "状态信息",
    "nav.archives": "历史数据",

    "gpu.detecting": "检测渲染方式中…",
    "gpu.webgl": "渲染: WebGL (GPU 加速)",
    "gpu.canvasNoWebgl": "渲染: Canvas（不支持 WebGL）",
    "gpu.canvasLost": "渲染: Canvas（GPU 上下文丢失，已回退）",

    "home.card.liveSessions": "Web UI 终端会话（进行中）",
    "home.card.totalSessions": "监测到的 Claude Code 会话总数",
    "home.card.totalEvents": "审计事件总数",
    "home.card.blocked": "已拦截的高危操作",
    "home.card.bypass": "疑似绕过监测",
    "home.card.clickHint": "点击查看 ›",
    "home.fileOps.title": "文件操作统计（Claude Code 发起的）",
    "home.fileOps.reads": "读取",
    "home.fileOps.writes": "写入",
    "home.fileOps.edits": "编辑",
    "home.fileOps.deletes": "删除（按命令文本近似识别，非精确）",
    "home.sourceBreakdown": "日志类型分布",
    "home.riskBreakdown": "风险等级分布",
    "home.auditCtl.hint": "控制 hooks 这次要不要真的判定/拦截——暂停/停止期间 Claude Code 的操作仍会正常执行，只是 CC-Monitor 不再介入",
    "home.auditCtl.start": "▶ 开始审计",
    "home.auditCtl.pause": "⏸ 暂停审计",
    "home.auditCtl.stop": "⏹ 停止审计",
    "auditState.running": "运行中",
    "auditState.paused": "已暂停",
    "auditState.stopped": "已停止",
    "topbar.auditState.title": "审计状态",
    "home.dataMgmt.hint": "当前展示的是实时事件数据；可以把它存档留存，或者清空重新开始统计",
    "home.dataMgmt.archive": "📦 持久化归档",
    "home.dataMgmt.clear": "🗑 清空当前数据",

    "archives.title": "历史数据记录",
    "archives.hint": "（首页“持久化归档”生成的快照，每份都是归档那一刻的完整事件数据）",
    "archives.empty": "还没有归档过任何数据——去首页点“持久化归档”存一份",
    "archives.unnamed": "（未命名）",
    "archives.createdAt": "归档时间",
    "archives.eventCount": "事件数",
    "archives.sessionCount": "会话数",
    "archives.range": "时间范围",
    "archives.open": "打开",
    "archives.delete": "删除",
    "archives.viewerTitle": "历史归档详情",
    "archives.viewerEmpty": "这份归档里没有事件（可能是文件损坏了）",
    "archives.loadMore": "加载更多",

    "logs.title": "审计日志",
    "logs.allSessions": "全部会话",
    "logs.autoScroll": "自动滚动到最新",
    "logs.empty": "还没有审计事件——装好 hooks 并用 Claude Code 跑点操作后，这里会实时出现",

    "terminal.title": "终端会话",
    "terminal.newSession": "+ 新建会话",
    "terminal.toGrid": "⊞ 切换到网格视图",
    "terminal.toSingle": "▤ 切换到单会话视图",
    "terminal.empty": "点击左侧“新建会话”启动一个 Claude Code 终端，可以直接在这里对话，不用再切到终端软件",
    "terminal.sessionListEmpty": "还没有会话，点击上方“新建会话”启动一个",
    "terminal.exited": "(已退出)",
    "terminal.close": "关闭",
    "terminal.running": "● 运行中",
    "terminal.stopped": "○ 已退出",
    "terminal.justNow": "刚刚",
    "terminal.minutesAgo": "{n} 分钟",
    "terminal.sessionEnded": "[会话已结束，退出码 {code}]",
    "terminal.connectionLost": "与终端会话的连接断开了，切换到其它会话或重新创建一个",
    "terminal.gridHint": "同屏显示所有进行中的会话，点击某个面板可以聚焦输入；只有点亮边框的那个会收到键盘输入。",
    "terminal.gridEmpty": "还没有进行中的会话——先新建一个",

    "modal.newSession.title": "新建终端会话",
    "modal.newSession.hint": "会在这个目录下打开一个 shell，并自动帮你敲好 <code>claude</code> 启动命令。",
    "modal.newSession.cwdLabel": "工作目录",
    "modal.newSession.cwdPlaceholder": "/home/you/project（留空用默认目录）",
    "modal.newSession.browse": "📁 浏览",
    "modal.dirBrowser.title": "选择文件夹",
    "modal.dirBrowser.select": "选择此文件夹",
    "modal.dirBrowser.empty": "（没有子目录，或者没有权限查看）",
    "modal.cancel": "取消",
    "modal.confirm": "确认",
    "modal.create": "创建",
    "modal.killSession.title": "关闭这个会话？",
    "modal.killSession.body": "会终止 {cwd} 下的这个终端进程（包括里面正在跑的 Claude Code），且无法恢复。",
    "modal.archive.title": "持久化归档",
    "modal.archive.hint": "把当前的事件数据完整存一份快照到历史记录里，可以起个名字方便以后识别（不填也可以）。归档之后当前数据不会被清空，如果想重新开始统计，请再点“清空当前数据”。",
    "modal.archive.labelLabel": "备注名称",
    "modal.archive.labelPlaceholder": "比如：上线前基线 / 2026-09-12 排查记录",
    "modal.archive.confirm": "存档",
    "modal.clearData.title": "清空当前事件数据？",
    "modal.clearData.body": "会把首页和日志里现在看到的这批事件数据全部丢弃，且无法恢复。如果还想保留，请先点“持久化归档”。",
    "modal.deleteArchive.title": "删除这份历史归档？",
    "modal.deleteArchive.body": "删除后无法恢复。",
    "modal.stopAudit.title": "停止审计？",
    "modal.stopAudit.body": "停止之后 Claude Code 的操作既不会被判定/拦截，也不会再被记录到审计日志——跟没装这个工具一样。真正想要的通常是“暂停”（继续记录，只是不拦截），确定要完全停止吗？",

    "error.fetchFailed": "连不上 CC-Monitor 服务端，稍后会自动重试（{msg}）",
    "error.requestFailed": "请求失败 ({status}) {path}{detail}",
    "error.ack": "知道了",

    "tap.selectPlaceholder": "选择一个会话…",
    "tap.noTranscript": "（无 transcript）",
    "tap.noTranscriptBody": "这个会话没有 transcript 记录（可能是装 hooks 之前开始的）",
    "tap.loading": "对话内容还没加载出来，稍等一下…",
    "tap.kind.user": "用户",
    "tap.kind.assistant": "Claude",
    "tap.kind.system": "系统",

    "status.usageTitle": "账号额度",
    "status.usageHint": "（跟 ccstatusline 读同一份 Claude Code 登录凭证查询，账号级别，所有会话共享）",
    "status.sessionTitle": "会话状态",
    "status.sessionHint": "（模型 / token 用量 / 吞吐速率 / cwd / git 分支 / 拦截情况）",
    "status.empty": "暂无数据——还没有 Web UI 会话，也没有监测到任何 Claude Code 会话",
    "status.usageError": "额度查询失败：{msg}",
    "status.usage.session": "单次额度（5 小时窗口）",
    "status.usage.weekly": "周额度（全部模型）",
    "status.usage.weeklySonnet": "周额度（Sonnet）",
    "status.usage.weeklyOpus": "周额度（Opus）",
    "status.usage.resetLabel": "重置",
    "status.hoursLater": "{n} 小时后",
    "status.daysLater": "{n} 天后",
    "status.durationMinutes": "持续 {n} 分钟",
    "status.eventCount": "{n} 条事件",
    "status.blockedCount": "🛑 拦截 {n}",
    "status.bypassCount": "⚠ 疑似绕过 {n}",

    "drilldown.close": "关闭",
    "drilldown.sessions.title": "会话列表（工作路径 · Session ID）",
    "drilldown.sessions.cwd": "工作路径",
    "drilldown.sessions.sessionId": "Session ID",
    "drilldown.sessions.model": "模型",
    "drilldown.sessions.events": "事件数",
    "drilldown.sessions.flags": "拦截/绕过",
    "drilldown.sessions.range": "时间范围",
    "drilldown.eventTypes.title": "审计事件类型明细（含产生它们的 Session）",
    "drilldown.eventTypes.times": "{n} 次",
    "drilldown.eventTypes.sessionId": "Session ID",
    "drilldown.eventTypes.count": "次数",
    "drilldown.eventTypes.none": "(无归属 session)",
    "drilldown.blocked.title": "被拦截的高危操作",
    "drilldown.blocked.empty": "还没有任何操作被拦截过",
    "drilldown.empty": "暂无数据",
    "drilldown.loading": "加载中…",
    "drilldown.fileOp.suffix": "详情",

    "decision.allowed": "放行",
    "decision.blocked": "拦截",
    "decision.completed": "已完成",
    "decision.observed": "系统观测",

    "source.hook_pre": "应用层 · 执行前",
    "source.hook_post": "应用层 · 执行后",
    "source.os_exec": "系统层 · 进程",
    "source.os_net": "系统层 · 网络",

    "risk.high": "高危",
    "risk.medium": "中危",
    "risk.low": "低危",
    "risk.info": "信息",
    "risk.-": "未分类",

    "stage.hook_pre": "准备执行",
    "stage.hook_post": "执行完成",
    "stage.os_exec": "内核观测",
    "stage.os_net": "内核观测",

    "tool.Bash": "执行 Shell 命令",
    "tool.Write": "写入文件",
    "tool.Edit": "编辑文件",
    "tool.MultiEdit": "批量编辑文件",
    "tool.NotebookEdit": "编辑 Notebook",
    "tool.Read": "读取文件",
    "tool.Glob": "查找文件",
    "tool.Grep": "搜索文件内容",
    "tool.WebFetch": "抓取网页",
    "tool.WebSearch": "网络搜索",
    "tool.Task": "启动子代理",
    "tool.Agent": "启动子代理",
    "tool.TodoWrite": "更新任务列表",

    "extra.result": "结果",
    "extra.output": "输出",

    "theme.brand": "标准配色",
    "theme.dark": "深色",
    "theme.light": "浅色",
    "theme.dracula": "Dracula",
    "theme.nord": "Nord",
    "theme.midnight": "午夜",
    "theme.ocean": "海洋",
    "theme.forest": "森林",
    "theme.sunset": "日落",
    "theme.rose": "玫瑰",
  },

  en: {
    "brand.title": "CC-Monitor",
    "nav.home": "Home",
    "nav.logs": "Audit Log",
    "nav.terminal": "Terminals",
    "nav.tap": "Claude Tap",
    "nav.status": "Status",
    "nav.archives": "History",

    "gpu.detecting": "Detecting renderer…",
    "gpu.webgl": "Renderer: WebGL (GPU-accelerated)",
    "gpu.canvasNoWebgl": "Renderer: Canvas (WebGL unavailable)",
    "gpu.canvasLost": "Renderer: Canvas (GPU context lost, fell back)",

    "home.card.liveSessions": "Web UI terminal sessions (active)",
    "home.card.totalSessions": "Claude Code sessions monitored",
    "home.card.totalEvents": "Total audit events",
    "home.card.blocked": "High-risk operations blocked",
    "home.card.bypass": "Suspected bypass attempts",
    "home.card.clickHint": "View details ›",
    "home.fileOps.title": "File operations (initiated by Claude Code)",
    "home.fileOps.reads": "Reads",
    "home.fileOps.writes": "Writes",
    "home.fileOps.edits": "Edits",
    "home.fileOps.deletes": "Deletes (approximated from command text, not exact)",
    "home.sourceBreakdown": "Event type breakdown",
    "home.riskBreakdown": "Risk level breakdown",
    "home.auditCtl.hint": "Controls whether hooks actually enforce/block right now — while paused or stopped, Claude Code's operations still run normally, CC-Monitor just stops intervening",
    "home.auditCtl.start": "▶ Start audit",
    "home.auditCtl.pause": "⏸ Pause audit",
    "home.auditCtl.stop": "⏹ Stop audit",
    "auditState.running": "Running",
    "auditState.paused": "Paused",
    "auditState.stopped": "Stopped",
    "topbar.auditState.title": "Audit state",
    "home.dataMgmt.hint": "You're viewing live event data; archive it to keep a copy, or clear it to start counting from zero",
    "home.dataMgmt.archive": "📦 Archive current data",
    "home.dataMgmt.clear": "🗑 Clear current data",

    "archives.title": "Historical Data",
    "archives.hint": "(Snapshots created via “Archive current data” on the Home tab — each one is a full copy of the event data at the moment it was archived)",
    "archives.empty": "No archives yet — go to Home and click “Archive current data”",
    "archives.unnamed": "(unnamed)",
    "archives.createdAt": "Archived at",
    "archives.eventCount": "Events",
    "archives.sessionCount": "Sessions",
    "archives.range": "Time range",
    "archives.open": "Open",
    "archives.delete": "Delete",
    "archives.viewerTitle": "Archive details",
    "archives.viewerEmpty": "No events in this archive (the file may be corrupted)",
    "archives.loadMore": "Load more",

    "logs.title": "Audit Log",
    "logs.allSessions": "All sessions",
    "logs.autoScroll": "Auto-scroll to latest",
    "logs.empty": "No audit events yet — once hooks are installed and Claude Code runs some operations, they'll show up here live",

    "terminal.title": "Terminal Sessions",
    "terminal.newSession": "+ New Session",
    "terminal.toGrid": "⊞ Switch to grid view",
    "terminal.toSingle": "▤ Switch to single view",
    "terminal.empty": "Click “New Session” on the left to start a Claude Code terminal — chat right here, no need to switch to a terminal app",
    "terminal.sessionListEmpty": "No sessions yet — click “New Session” above to start one",
    "terminal.exited": "(exited)",
    "terminal.close": "Close",
    "terminal.running": "● Running",
    "terminal.stopped": "○ Exited",
    "terminal.justNow": "just now",
    "terminal.minutesAgo": "{n} min",
    "terminal.sessionEnded": "[Session ended, exit code {code}]",
    "terminal.connectionLost": "Lost connection to this terminal session — switch to another one or start a new one",
    "terminal.gridHint": "Shows every active session on screen at once. Click a pane to focus it — only the highlighted one receives your keystrokes.",
    "terminal.gridEmpty": "No active sessions — create one first",

    "modal.newSession.title": "New Terminal Session",
    "modal.newSession.hint": "Opens a shell in this directory and types the <code>claude</code> launch command for you.",
    "modal.newSession.cwdLabel": "Working directory",
    "modal.newSession.cwdPlaceholder": "/home/you/project (leave blank for default)",
    "modal.newSession.browse": "📁 Browse",
    "modal.dirBrowser.title": "Select Folder",
    "modal.dirBrowser.select": "Select This Folder",
    "modal.dirBrowser.empty": "(no subdirectories, or no permission to view)",
    "modal.cancel": "Cancel",
    "modal.confirm": "Confirm",
    "modal.create": "Create",
    "modal.killSession.title": "Close this session?",
    "modal.killSession.body": "This will terminate the terminal process under {cwd} (including any Claude Code running inside it), and cannot be undone.",
    "modal.archive.title": "Archive Current Data",
    "modal.archive.hint": "Saves a full snapshot of the current event data into your history. You can give it a name to make it easier to find later (optional). Archiving does not clear the current data — click “Clear current data” if you want to start fresh.",
    "modal.archive.labelLabel": "Label",
    "modal.archive.labelPlaceholder": "e.g. pre-release baseline / 2026-09-12 investigation",
    "modal.archive.confirm": "Archive",
    "modal.clearData.title": "Clear current event data?",
    "modal.clearData.body": "This discards all the event data currently shown on Home and in the audit log, and cannot be undone. Archive it first if you want to keep a copy.",
    "modal.deleteArchive.title": "Delete this archive?",
    "modal.deleteArchive.body": "This cannot be undone.",
    "modal.stopAudit.title": "Stop audit?",
    "modal.stopAudit.body": "Once stopped, Claude Code's operations won't be evaluated/blocked, and won't be logged either — same as if this tool wasn't installed. What you usually want is “Pause” (keeps logging, just stops blocking) — are you sure you want to fully stop it?",

    "error.fetchFailed": "Can't reach the CC-Monitor server, will retry automatically ({msg})",
    "error.requestFailed": "Request failed ({status}) {path}{detail}",
    "error.ack": "Got it",

    "tap.selectPlaceholder": "Select a session…",
    "tap.noTranscript": " (no transcript)",
    "tap.noTranscriptBody": "This session has no transcript recorded (it may have started before hooks were installed)",
    "tap.loading": "Loading conversation content, one moment…",
    "tap.kind.user": "User",
    "tap.kind.assistant": "Claude",
    "tap.kind.system": "System",

    "status.usageTitle": "Account Quota",
    "status.usageHint": "(queried from the same Claude Code login credentials ccstatusline reads — account-wide, shared across all sessions)",
    "status.sessionTitle": "Session Status",
    "status.sessionHint": "(model / token usage / throughput / cwd / git branch / block status)",
    "status.empty": "No data yet — no Web UI sessions and no Claude Code sessions detected",
    "status.usageError": "Quota lookup failed: {msg}",
    "status.usage.session": "Session quota (5-hour window)",
    "status.usage.weekly": "Weekly quota (all models)",
    "status.usage.weeklySonnet": "Weekly quota (Sonnet)",
    "status.usage.weeklyOpus": "Weekly quota (Opus)",
    "status.usage.resetLabel": "Resets",
    "status.hoursLater": "in {n}h",
    "status.daysLater": "in {n}d",
    "status.durationMinutes": "{n} min elapsed",
    "status.eventCount": "{n} events",
    "status.blockedCount": "🛑 {n} blocked",
    "status.bypassCount": "⚠ {n} suspected bypass",

    "drilldown.close": "Close",
    "drilldown.sessions.title": "Sessions (working directory · Session ID)",
    "drilldown.sessions.cwd": "Working Directory",
    "drilldown.sessions.sessionId": "Session ID",
    "drilldown.sessions.model": "Model",
    "drilldown.sessions.events": "Events",
    "drilldown.sessions.flags": "Blocked/Bypass",
    "drilldown.sessions.range": "Time Range",
    "drilldown.eventTypes.title": "Event type breakdown (by originating session)",
    "drilldown.eventTypes.times": "{n} times",
    "drilldown.eventTypes.sessionId": "Session ID",
    "drilldown.eventTypes.count": "Count",
    "drilldown.eventTypes.none": "(no associated session)",
    "drilldown.blocked.title": "Blocked High-Risk Operations",
    "drilldown.blocked.empty": "Nothing has been blocked yet",
    "drilldown.empty": "No data",
    "drilldown.loading": "Loading…",
    "drilldown.fileOp.suffix": "Details",

    "decision.allowed": "Allowed",
    "decision.blocked": "Blocked",
    "decision.completed": "Completed",
    "decision.observed": "Observed",

    "source.hook_pre": "App layer · pre",
    "source.hook_post": "App layer · post",
    "source.os_exec": "Kernel layer · process",
    "source.os_net": "Kernel layer · network",

    "risk.high": "High",
    "risk.medium": "Medium",
    "risk.low": "Low",
    "risk.info": "Info",
    "risk.-": "Unclassified",

    "stage.hook_pre": "Pre-exec",
    "stage.hook_post": "Post-exec",
    "stage.os_exec": "Kernel observed",
    "stage.os_net": "Kernel observed",

    "tool.Bash": "Run shell command",
    "tool.Write": "Write file",
    "tool.Edit": "Edit file",
    "tool.MultiEdit": "Batch-edit files",
    "tool.NotebookEdit": "Edit notebook",
    "tool.Read": "Read file",
    "tool.Glob": "Find files",
    "tool.Grep": "Search file contents",
    "tool.WebFetch": "Fetch web page",
    "tool.WebSearch": "Web search",
    "tool.Task": "Spawn subagent",
    "tool.Agent": "Spawn subagent",
    "tool.TodoWrite": "Update todo list",

    "extra.result": "Result",
    "extra.output": "Output",

    "theme.brand": "Brand",
    "theme.dark": "Dark",
    "theme.light": "Light",
    "theme.dracula": "Dracula",
    "theme.nord": "Nord",
    "theme.midnight": "Midnight",
    "theme.ocean": "Ocean",
    "theme.forest": "Forest",
    "theme.sunset": "Sunset",
    "theme.rose": "Rose",
  },
};

let currentLang = localStorage.getItem("cc_monitor_lang") || "zh";

function t(key, vars) {
  const dict = I18N[currentLang] || I18N.zh;
  let s = dict[key] !== undefined ? dict[key] : (I18N.zh[key] !== undefined ? I18N.zh[key] : key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp("\\{" + k + "\\}", "g"), v);
    }
  }
  return s;
}

function setLang(lang) {
  currentLang = lang === "en" ? "en" : "zh";
  localStorage.setItem("cc_monitor_lang", currentLang);
  applyStaticI18n();
}

// 处理静态 HTML 里带 data-i18n / data-i18n-html / data-i18n-placeholder / data-i18n-title 的元素。
// data-i18n 用 textContent（安全，字典里的普通文案都走这个）；
// data-i18n-html 用 innerHTML（只用于字典里明确需要行内标签的几条，比如 modal hint 里的 <code>）。
function applyStaticI18n() {
  document.documentElement.lang = currentLang === "en" ? "en" : "zh-CN";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.getAttribute("data-i18n-html"));
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
  });
  const langBtn = document.getElementById("lang-toggle-btn");
  if (langBtn) langBtn.textContent = currentLang === "zh" ? "EN" : "中文";
}

// ---------- 主题 ----------
const THEMES = ["brand", "dark", "light", "dracula", "nord", "midnight", "ocean", "forest", "sunset", "rose"];
let currentTheme = localStorage.getItem("cc_monitor_theme") || "brand";

function applyTheme(theme) {
  currentTheme = THEMES.includes(theme) ? theme : "brand";
  document.documentElement.setAttribute("data-theme", currentTheme);
  localStorage.setItem("cc_monitor_theme", currentTheme);
  const select = document.getElementById("theme-select");
  if (select) select.value = currentTheme;
}
