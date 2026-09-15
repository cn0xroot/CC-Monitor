"use strict";
// JS 版的 cc_monitor/format.py + cc_monitor/colors.py：把审计事件翻译成人类可读的 HTML 片段
// （用 CSS class 上色，而不是终端 ANSI 码，因为渲染目标是浏览器）。

const TOOL_LABELS = {
  Bash: "执行 Shell 命令",
  Write: "写入文件",
  Edit: "编辑文件",
  MultiEdit: "批量编辑文件",
  NotebookEdit: "编辑 Notebook",
  Read: "读取文件",
  Glob: "查找文件",
  Grep: "搜索文件内容",
  WebFetch: "抓取网页",
  WebSearch: "网络搜索",
  Task: "启动子代理",
  Agent: "启动子代理",
  TodoWrite: "更新任务列表",
  UserPromptSubmit: "用户提交提示词",
  SessionStart: "会话开始",
  SessionEnd: "会话结束",
  PreCompact: "上下文压缩前",
  Stop: "主任务结束",
  SubagentStop: "子代理结束",
};

const STAGE_LABELS = {
  hook_pre: "准备执行",
  hook_post: "执行完成",
  hook_prompt: "用户输入",
  hook_lifecycle: "生命周期",
  os_exec: "内核观测",
  os_net: "内核观测",
};

const MAX_SUMMARY_LEN = 240;
const MAX_OUTPUT_LEN = 300;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function collapse(text, limit = MAX_SUMMARY_LEN) {
  if (text === null || text === undefined) return "";
  let s = String(text).replace(/\r\n/g, " ⏎ ").replace(/\n/g, " ⏎ ");
  if (s.length > limit) return s.slice(0, limit) + `...(共${s.length}字符，已截断)`;
  return s;
}

// Bash 简易语法高亮：命令名/参数/字符串/变量/管道重定向分别标记 CSS class。
const SHELL_TOKEN_RE =
  /(?<comment>#[^⏎]*)|(?<dstring>"(?:[^"\\]|\\.)*")|(?<sstring>'[^']*')|(?<var>\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@#?*!$-])|(?<op>\|\||&&|;;|>>|<<|[|;&<>])|(?<flag>(?<!\S)--?[A-Za-z][\w-]*)|(?<glyph>⏎)|(?<word>[^\s|;&<>$'"#]+)|(?<space>\s+)|(?<other>.)/g;

function highlightBashHtml(text) {
  if (!text) return "";
  const out = [];
  let expectCommand = true;
  const re = new RegExp(SHELL_TOKEN_RE);
  let m;
  while ((m = re.exec(text)) !== null) {
    const g = m.groups;
    const esc = escapeHtml(m[0]);
    if (g.comment) out.push(`<span class="tok-comment">${esc}</span>`);
    else if (g.dstring || g.sstring) out.push(`<span class="tok-string">${esc}</span>`);
    else if (g.var) out.push(`<span class="tok-var">${esc}</span>`);
    else if (g.op) {
      out.push(`<span class="tok-op">${esc}</span>`);
      expectCommand = true;
    } else if (g.flag) out.push(`<span class="tok-flag">${esc}</span>`);
    else if (g.glyph) out.push(`<span class="tok-glyph">${esc}</span>`);
    else if (g.word) {
      if (expectCommand) {
        out.push(`<span class="tok-cmd">${esc}</span>`);
        expectCommand = false;
      } else out.push(esc);
    } else out.push(esc);
    if (m.index === re.lastIndex) re.lastIndex += 1; // 防止零宽匹配死循环
  }
  return out.join("");
}

// 命令输出/日志简易高亮：报错/警告/成功关键字、文件路径。
const LOG_TOKEN_RE =
  /(?<error>\b(?:error|exception|traceback|fatal|failed?|panic|denied|refused)\b|错误|异常|失败|拒绝)|(?<warn>\b(?:warn(?:ing)?|deprecated)\b|警告)|(?<ok>\b(?:success(?:ful)?|passed|done|ok)\b|成功|完成)|(?<path>(?:(?<=\s)|^)\/[\w./-]+|\b[\w.-]+\.(?:py|js|ts|json|sh|log|txt|md|yaml|yml|c|cpp|h|go|rs)\b)|(?<glyph>⏎)/gi;

function highlightLogHtml(text) {
  if (!text) return "";
  const out = [];
  let last = 0;
  const re = new RegExp(LOG_TOKEN_RE);
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(escapeHtml(text.slice(last, m.index)));
    const g = m.groups;
    const tok = escapeHtml(m[0]);
    if (g.error) out.push(`<span class="tok-error">${tok}</span>`);
    else if (g.warn) out.push(`<span class="tok-warn">${tok}</span>`);
    else if (g.ok) out.push(`<span class="tok-ok">${tok}</span>`);
    else if (g.path) out.push(`<span class="tok-path">${tok}</span>`);
    else if (g.glyph) out.push(`<span class="tok-glyph">${tok}</span>`);
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  out.push(escapeHtml(text.slice(last)));
  return out.join("");
}

function splitDetail(source, detail) {
  detail = detail || {};
  if (source === "hook_post") return [detail.input || {}, detail.response || null];
  return [detail, null];
}

function stageLabel(source) {
  return STAGE_LABELS[source] || source || "-";
}

function describeOsExec(comm, detail) {
  detail = detail || {};
  const label = `系统层观测: 进程执行 (${escapeHtml(comm)})`;
  const summaryHtml = highlightBashHtml(collapse(detail.argv || ""));
  const extra = [];
  if (detail.shell_command) {
    if (detail.hook_matched === false) {
      extra.push({ cls: "warn", label: null, html: "⚠ 未匹配到对应的 hook 记录，可能绕过了监测" });
    } else if (detail.hook_matched === true) {
      extra.push({ cls: "ok", label: null, html: "✓ 与 hook 记录吻合" });
    }
  }
  return { label, summaryHtml, extra };
}

function describeOsNet(comm, detail) {
  detail = detail || {};
  const { ip = "", port = "", host } = detail;
  const summary = `${ip}:${port}` + (host ? ` (${host})` : "");
  return { label: `系统层观测: 网络连接 (${escapeHtml(comm)})`, summaryHtml: escapeHtml(summary), extra: [] };
}

function describe(toolName, source, detail) {
  if (source === "os_exec") return describeOsExec(toolName, detail);
  if (source === "os_net") return describeOsNet(toolName, detail);

  const [toolInput, response] = splitDetail(source, detail);
  const label = TOOL_LABELS[toolName] || toolName || "未知操作";
  let summaryHtml = "";
  const extra = [];

  if (toolName === "Bash") {
    summaryHtml = highlightBashHtml(collapse(toolInput.command || ""));
    if (response) {
      const stderr = (response.stderr || "").trim();
      const interrupted = !!response.interrupted;
      const ok = !interrupted && !stderr;
      extra.push({ cls: ok ? "ok" : "error", label: "结果", html: ok ? "成功" : "失败/有错误输出" });
      const tailSrc = (response.stdout || "").trim() || stderr;
      if (tailSrc) {
        extra.push({ cls: null, label: "输出", html: highlightLogHtml(collapse(tailSrc.slice(-MAX_OUTPUT_LEN))) });
      }
    }
  } else if (toolName === "Write" || toolName === "NotebookEdit") {
    const p = toolInput.file_path || toolInput.notebook_path || "";
    const content = toolInput.content || toolInput.new_source || "";
    summaryHtml = escapeHtml(`${p} (${String(content).length} 字节)`);
  } else if (toolName === "Edit" || toolName === "MultiEdit") {
    const p = toolInput.file_path || "";
    const oldS = toolInput.old_string || "";
    const newS = toolInput.new_string || "";
    summaryHtml = escapeHtml(`${p} (-${oldS.length} / +${newS.length} 字符)`);
  } else if (toolName === "Read") {
    summaryHtml = escapeHtml(toolInput.file_path || "");
  } else if (toolName === "Glob" || toolName === "Grep") {
    const pattern = toolInput.pattern || "";
    const p = toolInput.path;
    summaryHtml = escapeHtml(pattern + (p ? `  (路径: ${p})` : ""));
  } else if (toolName === "WebFetch") {
    summaryHtml = escapeHtml(toolInput.url || "");
  } else if (toolName === "WebSearch") {
    summaryHtml = escapeHtml(toolInput.query || "");
  } else if (toolName === "Task" || toolName === "Agent") {
    summaryHtml = escapeHtml(collapse(toolInput.description || toolInput.prompt || ""));
  } else if (toolName === "UserPromptSubmit") {
    summaryHtml = escapeHtml(collapse(toolInput.prompt || ""));
  } else if (toolName === "SessionStart" || toolName === "SessionEnd" || toolName === "PreCompact") {
    summaryHtml = escapeHtml(toolInput.source || toolInput.reason || toolInput.trigger || "-");
    if (toolName === "PreCompact" && toolInput.custom_instructions) {
      extra.push({ cls: null, label: "自定义压缩指令", html: escapeHtml(collapse(toolInput.custom_instructions)) });
    }
  } else if (toolName === "Stop" || toolName === "SubagentStop") {
    summaryHtml = escapeHtml(`stop_hook_active: ${!!toolInput.stop_hook_active}`);
  } else {
    for (const [k, v] of Object.entries(toolInput)) {
      if (v) {
        summaryHtml = escapeHtml(`${k}=${collapse(v)}`);
        break;
      }
    }
  }
  return { label, summaryHtml, extra };
}

module.exports = { describe, stageLabel, escapeHtml, TOOL_LABELS, highlightBashHtml, highlightLogHtml, collapse };
