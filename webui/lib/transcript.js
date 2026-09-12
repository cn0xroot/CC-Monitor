"use strict";
// Claude Tap：JS 版的 cc_monitor/transcript.py 端口。解析 Claude Code 本地 transcript
// (~/.claude/projects/.../<session>.jsonl)，把发给/收到模型的完整对话内容转成
// HTML（用 CSS class 上色），供 Web UI 渲染。不是抓包，读的是 Claude Code 自己
// 已经写在本地磁盘上的文件。
const fs = require("fs");
const fmt = require("./format");
const { escapeHtml, highlightBashHtml, highlightLogHtml } = fmt;

const KIND_LABEL = { user: "用户", assistant: "Claude", system: "系统" };

function normalizeContent(content) {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.filter((b) => b && typeof b === "object");
  return [];
}

function describeEntry(obj) {
  const etype = obj.type;
  const ts = obj.timestamp;
  const uuid = obj.uuid;

  if (etype === "user") {
    const msg = obj.message || {};
    return { kind: "user", ts, uuid, blocks: normalizeContent(msg.content), usage: null, model: null };
  }
  if (etype === "assistant") {
    const msg = obj.message || {};
    return {
      kind: "assistant",
      ts,
      uuid,
      blocks: normalizeContent(msg.content),
      usage: msg.usage || null,
      model: msg.model || null,
    };
  }
  if (etype === "attachment") {
    const att = obj.attachment || {};
    const text = att.text !== undefined ? att.text : JSON.stringify(att).slice(0, 500);
    return { kind: "system", ts, uuid, blocks: [{ type: "text", text }], usage: null, model: null };
  }
  return null;
}

function countLines(path) {
  try {
    const data = fs.readFileSync(path, "utf8");
    if (!data) return 0;
    return data.split("\n").filter((l) => l.length > 0).length;
  } catch (e) {
    return 0;
  }
}

// 从 start_line（0-based，之前已读过多少行）之后开始读，最多 limit 条解析结果。
// 返回 {entries, nextLine}。用同步读取 + 手工按行切分，避免为一个小文件拉起
// readline 的异步开销（transcript 通常几百 KB ~ 几 MB，同步读没问题）。
function readEntries(path, startLine = 0, limit = 500) {
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e) {
    return { entries: [], nextLine: startLine };
  }
  const lines = raw.split("\n");
  const entries = [];
  let nextLine = startLine;
  for (let i = startLine; i < lines.length; i++) {
    nextLine = i + 1;
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }
    const entry = describeEntry(obj);
    if (entry) entries.push(entry);
    if (entries.length >= limit) break;
  }
  return { entries, nextLine };
}

// 刚选中一个会话时用——给"最近在做什么"，不是从文件第一行开始翻。之前 pollTap()
// 无论会话开了多久，第一次都从 since_line=0 读，对跑了好几天、几万行的长会话
// （比如常驻的 Tesla 分析会话）来说，看到的会是好几天前的历史消息，
// 完全不是"实时"——这正是"读的是文件里的旧内容，不是实时对话"这个 bug 的根因。
// 从文件末尾往前扫，找够 limit 条能解析成功的 entry 就停，最后翻回时间正序返回；
// nextLine 设成整个文件的行数，后续轮询从这里继续往后读，就是真正的"实时增量"了。
// 这里只在"刚选中会话"这一次性场景触发（不是每次轮询都读整个文件），所以直接读全量
// 换取行号精确对得上，不用像 getTokenStats 那样只读尾部字节做近似估算。
function readTailEntries(path, limit = 300) {
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e) {
    return { entries: [], nextLine: 0 };
  }
  const lines = raw.split("\n");
  const nextLine = lines.length;
  const entries = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }
    const entry = describeEntry(obj);
    if (entry) entries.push(entry);
  }
  entries.reverse();
  return { entries, nextLine };
}

// 只读文件尾部若干字节，避免为了算"最近的吞吐率"把几 MB 的 transcript 整个读一遍。
// 从任意字节位置切开，开头那一行大概率是被切断的半截 JSON，解析失败直接跳过就行，
// 反正只是想要"最近这一段"的近似值，不是精确到第一条消息。
function readTail(path, maxBytes = 500000) {
  let fd;
  try {
    fd = fs.openSync(path, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } catch (e) {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (e) {
        // ignore
      }
    }
  }
}

// 用最近一段窗口里的 assistant 轮次估算 token 吞吐（每秒多少 token）——不是精确的
// 逐 token 流式速率（transcript 里没有那个粒度的时间戳），是"这几轮平均下来大概多快"。
function getTokenStats(path) {
  if (!path) return null;
  const raw = readTail(path, 500000);
  const turns = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      continue;
    }
    if (obj.type === "assistant" && obj.message && obj.message.usage && obj.timestamp) {
      const t = Date.parse(obj.timestamp);
      if (!Number.isNaN(t)) turns.push({ ts: t, usage: obj.message.usage });
    }
  }
  if (turns.length === 0) return null;

  const last = turns[turns.length - 1];
  const sum = (key) => turns.reduce((s, t) => s + (t.usage[key] || 0), 0);
  const totalIn = sum("input_tokens");
  const totalOut = sum("output_tokens");
  const totalCacheRead = sum("cache_read_input_tokens");

  let outputTokensPerSec = null;
  let inputTokensPerSec = null;
  if (turns.length >= 2) {
    const spanSec = (last.ts - turns[0].ts) / 1000;
    if (spanSec > 0.5) {
      outputTokensPerSec = totalOut / spanSec;
      inputTokensPerSec = totalIn / spanSec;
    }
  }

  return {
    lastUsage: last.usage,
    windowTurns: turns.length,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    totalCacheReadTokens: totalCacheRead,
    outputTokensPerSec,
    inputTokensPerSec,
  };
}

// 找 session 里第一次出现的 assistant.message.model，给 UI 展示用。
// 简单加一层按 (path,mtime) 的缓存，避免日志会话列表每次轮询都重新扫文件。
const modelCache = new Map(); // path -> {mtime, model}
function getModel(path) {
  if (!path) return null;
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(path).mtimeMs;
  } catch (e) {
    return null;
  }
  const cached = modelCache.get(path);
  if (cached && cached.mtime === mtimeMs) return cached.model;

  let model = null;
  try {
    const raw = fs.readFileSync(path, "utf8");
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length && i < 400; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (obj.type === "assistant" && obj.message && obj.message.model) {
        model = obj.message.model;
        break;
      }
    }
  } catch (e) {
    model = null;
  }
  modelCache.set(path, { mtime: mtimeMs, model });
  return model;
}

function collapse(text, limit = 500) {
  if (text === null || text === undefined) return "";
  let s = String(text).replace(/\r\n/g, " ⏎ ").replace(/\n/g, " ⏎ ");
  if (s.length > limit) return s.slice(0, limit) + `...(共${s.length}字符，已截断)`;
  return s;
}

function renderBlockHtml(block) {
  const btype = block.type;
  if (btype === "text") {
    const text = (block.text || "").trim();
    if (!text) return "";
    return `<div class="tap-block tap-text">${escapeHtml(collapse(text, 2000))}</div>`;
  }
  if (btype === "thinking") {
    const text = (block.thinking || "").trim();
    const shown = text ? escapeHtml(collapse(text, 800)) : "(内容已省略)";
    return `<div class="tap-block tap-thinking">💭 思考: ${shown}</div>`;
  }
  if (btype === "tool_use") {
    const name = block.name || "?";
    const input = block.input || {};
    let bodyHtml;
    if (name === "Bash" && typeof input.command === "string") {
      bodyHtml = highlightBashHtml(collapse(input.command, 600));
    } else {
      bodyHtml = escapeHtml(collapse(JSON.stringify(input), 600));
    }
    return `<div class="tap-block tap-tool-use"><span class="tap-tool-name">🔧 ${escapeHtml(name)}</span>: ${bodyHtml}</div>`;
  }
  if (btype === "tool_result") {
    const content = block.content;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const isError = !!block.is_error;
    const rendered = highlightLogHtml(collapse(text, 800));
    const cls = isError ? "tap-tool-result-error" : "tap-tool-result";
    const prefix = isError ? "✗ 工具结果(错误)" : "✓ 工具结果";
    return `<div class="tap-block ${cls}"><span class="tap-tool-label">${prefix}</span>: ${rendered}</div>`;
  }
  if (btype === "image") {
    return `<div class="tap-block tap-image">🖼 [图片内容，未显示]</div>`;
  }
  return `<div class="tap-block tap-unknown">[${escapeHtml(btype)}]</div>`;
}

function renderEntryHtml(entry) {
  const blocksHtml = entry.blocks.map(renderBlockHtml).filter(Boolean).join("");
  let usageHtml = "";
  if (entry.kind === "assistant" && entry.usage) {
    const u = entry.usage;
    usageHtml = ` <span class="tap-usage">in=${u.input_tokens || 0} out=${u.output_tokens || 0} cache_read=${u.cache_read_input_tokens || 0}</span>`;
  }
  return {
    kind: entry.kind,
    kindLabel: KIND_LABEL[entry.kind] || entry.kind,
    ts: entry.ts,
    usageHtml,
    blocksHtml,
  };
}

module.exports = { countLines, readEntries, readTailEntries, getModel, getTokenStats, renderEntryHtml };
