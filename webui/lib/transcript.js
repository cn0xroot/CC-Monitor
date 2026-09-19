"use strict";
// AI Tap：JS 版的 cc_monitor/transcript.py 端口。解析 Claude Code 本地 transcript
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

// ---- 多格式：跟 cc_monitor/transcript.py 的 describe_entry 一一对应，改一边要同步另一边 ----
const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;

function unquoteArg(v) {
  // Antigravity 把工具入参每个值都再 JSON 编码了一层（"\"/home/x\""），拆掉那一层
  if (typeof v === "string" && v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    try {
      return JSON.parse(v);
    } catch (e) {
      return v;
    }
  }
  return v;
}

function describeAntigravity(obj) {
  const ts = obj.created_at;
  const uuid = `step-${obj.step_index}`;
  if (obj.type === "USER_INPUT") {
    const content = obj.content || "";
    const m = USER_REQUEST_RE.exec(content);
    return { kind: "user", ts, uuid, blocks: [{ type: "text", text: m ? m[1] : content }], usage: null, model: null };
  }
  if (obj.type === "PLANNER_RESPONSE") {
    const blocks = [];
    if (obj.thinking) blocks.push({ type: "thinking", thinking: obj.thinking });
    if (obj.content) blocks.push({ type: "text", text: obj.content });
    for (const tc of obj.tool_calls || []) {
      if (!tc || typeof tc !== "object") continue;
      const args = tc.args && typeof tc.args === "object" ? Object.fromEntries(Object.entries(tc.args).map(([k, v]) => [k, unquoteArg(v)])) : tc.args || {};
      blocks.push({ type: "tool_use", name: tc.name || "", input: args });
    }
    return { kind: "assistant", ts, uuid, blocks, usage: null, model: obj.model || null };
  }
  if (obj.type === "GENERIC" && obj.source === "MODEL") {
    return { kind: "user", ts, uuid, blocks: [{ type: "tool_result", content: obj.content || "" }], usage: null, model: null };
  }
  return null;
}

function describeCodex(obj) {
  const ts = obj.timestamp;
  const payload = obj.payload || {};
  const ptype = payload.type;
  const uuid = payload.id || payload.call_id;
  if (obj.type === "response_item") {
    if (ptype === "message") {
      const texts = [];
      for (const c of payload.content || []) {
        if (c && typeof c === "object" && typeof c.text === "string") texts.push(c.text);
        else if (typeof c === "string") texts.push(c);
      }
      return { kind: payload.role === "assistant" ? "assistant" : "user", ts, uuid, blocks: [{ type: "text", text: texts.join("\n") }], usage: null, model: null };
    }
    if (ptype === "reasoning") {
      const text = (payload.summary || []).map((x) => (x && x.text) || "").join("\n");
      return { kind: "assistant", ts, uuid, blocks: [{ type: "thinking", thinking: text }], usage: null, model: null };
    }
    if (ptype === "function_call" || ptype === "custom_tool_call") {
      let args = ptype === "function_call" ? payload.arguments : payload.input;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch (e) {
          args = { input: args };
        }
      }
      return { kind: "assistant", ts, uuid, blocks: [{ type: "tool_use", name: payload.name || "", input: args || {} }], usage: null, model: null };
    }
    if (ptype === "function_call_output" || ptype === "custom_tool_call_output") {
      return { kind: "user", ts, uuid, blocks: [{ type: "tool_result", content: payload.output || "" }], usage: null, model: null };
    }
    return null;
  }
  if (obj.type === "event_msg" && ptype === "token_count") {
    const info = payload.info || {};
    const last = info.last_token_usage || info.total_token_usage;
    if (!last) return null;
    return {
      kind: "assistant", ts, uuid, blocks: [],
      usage: { input_tokens: last.input_tokens || 0, output_tokens: last.output_tokens || 0, cache_read_input_tokens: last.cached_input_tokens || 0 },
      model: null,
    };
  }
  if (obj.type === "turn_context" && payload.model) {
    return { kind: "system", ts, uuid, blocks: [], usage: null, model: payload.model };
  }
  return null;
}

function detectFormat(obj) {
  if (obj && "step_index" in obj && "source" in obj) return "antigravity";
  if (obj && "payload" in obj && ["response_item", "event_msg", "session_meta", "turn_context"].includes(obj.type)) return "codex";
  return "claude";
}

function describeEntry(obj) {
  const format = detectFormat(obj);
  if (format === "antigravity") return describeAntigravity(obj);
  if (format === "codex") return describeCodex(obj);
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
  // 按模型分桶——同一个 session 中途换模型（比如从 Sonnet 切到 Opus）很常见，
  // 一次扫描顺便按 message.model 分组，不用为了"不同模型的使用情况统计"再单独
  // 重新扫一遍文件。
  const byModel = {};
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
      const model = obj.message.model || "unknown";
      const u = obj.message.usage;
      if (!byModel[model]) byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turns: 0 };
      const b = byModel[model];
      b.inputTokens += u.input_tokens || 0;
      b.outputTokens += u.output_tokens || 0;
      b.cacheReadTokens += u.cache_read_input_tokens || 0;
      b.cacheCreationTokens += u.cache_creation_input_tokens || 0;
      b.turns += 1;
    }
  }
  if (turns.length === 0) return null;

  const last = turns[turns.length - 1];
  const sum = (key) => turns.reduce((s, t) => s + (t.usage[key] || 0), 0);
  const totalIn = sum("input_tokens");
  const totalOut = sum("output_tokens");
  const totalCacheRead = sum("cache_read_input_tokens");
  // ccstatusline 的 "Cached" 是 cache_read + cache_creation 两种一起算的，"Total" 再把
  // input/output/cached 三个加起来——跟 Claude Code 自己那套 token 统计口径对齐，不是
  // 我们自己发明的算法。
  const totalCacheCreation = sum("cache_creation_input_tokens");
  const totalCached = totalCacheRead + totalCacheCreation;
  const totalTokens = totalIn + totalOut + totalCached;

  let outputTokensPerSec = null;
  let inputTokensPerSec = null;
  if (turns.length >= 2) {
    const spanSec = (last.ts - turns[0].ts) / 1000;
    if (spanSec > 0.5) {
      outputTokensPerSec = totalOut / spanSec;
      inputTokensPerSec = totalIn / spanSec;
    }
  }

  // "上下文窗口用了多少"不是把整个 session 的 token 全部加起来（那是"总共花了多少
  // 钱/token"，跟 totalTokens 一样），是看最后一轮对话实际带着多大的上下文——跟
  // ccstatusline 的 getContextWindowMetrics() 同一个算法：input + cache_read +
  // cache_creation，只取最后一条。
  const lu = last.usage;
  const contextTokens = (lu.input_tokens || 0) + (lu.cache_read_input_tokens || 0) + (lu.cache_creation_input_tokens || 0);

  return {
    lastUsage: last.usage,
    windowTurns: turns.length,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    totalCacheReadTokens: totalCacheRead,
    totalCacheCreationTokens: totalCacheCreation,
    totalCachedTokens: totalCached,
    totalTokens,
    contextTokens,
    outputTokensPerSec,
    inputTokensPerSec,
    byModel,
  };
}

// Context compaction——Claude Code 自动/手动把上下文摘要压缩之后，transcript 里会
// 插一条 type="system" subtype="compact_boundary" 的记录，compactMetadata 里带着
// 触发方式（auto/manual）和压缩前后的 token 数。压缩事件很稀疏（一个 session 里
// 通常 0～几条），不用只看 tail，直接整份文件扫一遍字符串前过滤，代价很小。
function getCompactionStats(path) {
  if (!path) return null;
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e) {
    return null;
  }
  let count = 0;
  let autoCount = 0;
  let manualCount = 0;
  let cumulativeDroppedTokens = 0;
  for (const line of raw.split("\n")) {
    if (!line.includes('"compact_boundary"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (obj.type !== "system" || obj.subtype !== "compact_boundary" || obj.isSidechain === true) continue;
    count += 1;
    const trigger = obj.compactMetadata?.trigger;
    if (trigger === "auto") autoCount += 1;
    else if (trigger === "manual") manualCount += 1;
    const dropped = obj.compactMetadata?.cumulativeDroppedTokens;
    if (typeof dropped === "number" && dropped > cumulativeDroppedTokens) cumulativeDroppedTokens = dropped;
  }
  if (count === 0) return { count: 0, autoCount: 0, manualCount: 0, cumulativeDroppedTokens: 0 };
  return { count, autoCount, manualCount, cumulativeDroppedTokens };
}

// 会话当前在用的模型，给 UI 展示用：取 transcript 里**最近一次**带 model 的 assistant 轮次。
// 以前取的是第一次出现的——用户中途 /model 切换后（比如 Sonnet 切 Opus），会话列表里
// 显示的还是开头那个模型，怎么等都不更新。从文件尾部往前找就是"现在用的"；
// 尾部那一段（500KB）里一条 assistant 都没有的极端情况再退回从头扫。
// 缓存按 (path, mtime)，文件一变就重算，轮询里不会反复读整个文件。
const modelCache = new Map(); // path -> {mtime, model}
function modelFromLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    return null;
  }
  if (obj.type === "assistant" && obj.message && obj.message.model) return obj.message.model;
  if (detectFormat(obj) !== "claude") {
    const e = describeEntry(obj);
    if (e && e.model) return e.model;
  }
  return null;
}

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
    const tailLines = readTail(path, 500000).split("\n");
    for (let i = tailLines.length - 1; i >= 0 && model === null; i--) model = modelFromLine(tailLines[i]);
    if (model === null) {
      const lines = fs.readFileSync(path, "utf8").split("\n");
      for (let i = 0; i < lines.length && i < 400 && model === null; i++) model = modelFromLine(lines[i]);
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

// 专给 JSON 格式化输出用——只按长度截断，不能像 collapse() 那样把换行替换成
// " ⏎ " 占位符，不然缩进结构就全毁了，那还叫什么"JSON 格式显示"。
function truncateKeepNewlines(text, limit = 4000) {
  if (text.length > limit) return text.slice(0, limit) + `\n...(共${text.length}字符，已截断)`;
  return text;
}

function renderBlockHtml(block) {
  const btype = block.type;
  if (btype === "text") {
    const text = (block.text || "").trim();
    if (!text) return "";
    return `<div class="tap-block tap-text">${escapeHtml(collapse(text, 2000))}</div>`;
  }
  if (btype === "thinking") {
    // 之前限 800 字符，长一点的思考过程基本全被截断成"...已截断"；现在放宽到 2 万字符
    // （对思考内容来说已经算"全量"了，只是留个上限防极端情况），配合前端"显示详情"
    // 开关做折叠/展开——折叠态默认只露出几行，开关打开就是这里给的完整内容。
    // 注意：如果这里显示"(内容已省略)"，是因为 transcript 里这条 thinking block 本身
    // 就没存文字内容（Claude Code 没有把这次的思考过程落盘），不是我们这边主动截掉的，
    // 开关对这种情况没有效果——没有数据，开了也变不出来。
    const text = (block.thinking || "").trim();
    // 原来这里写的是"(内容已省略)"，看着很像是我们主动截掉/隐藏了什么，
    // 用户一直追着问"怎么还是这样、fix bug"——实际是 Claude Code 自己压根没把这次
    // 思考正文存到本地 transcript 里（只留了个校验用的 signature），不是能靠开关
    // 或者代码修复解决的事，文案直接说清楚原因，别让人以为这是我们这边能修的 bug。
    const shown = text
      ? escapeHtml(collapse(text, 20000))
      : `<span class="tap-thinking-empty">（Claude Code 未在本地保存这段思考正文，仅保留校验签名，无法显示）</span>`;
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
    // "用户"这一轮里的工具结果，content 本身经常不是纯文本，而是一个结构化对象/数组
    // （比如带图片的多段内容）。之前统一 JSON.stringify 成一行塞进去，几百个字符挤在
    // 一起完全没法读；结构化内容改成带缩进的 JSON 格式单独用等宽块显示，纯字符串的
    // 还是走原来的日志高亮，不用为了统一格式反而把本来可读的纯文本也拆碎。
    const content = block.content;
    const isError = !!block.is_error;
    const cls = isError ? "tap-tool-result-error" : "tap-tool-result";
    const prefix = isError ? "✗ 工具结果(错误)" : "✓ 工具结果";
    if (typeof content === "string") {
      const rendered = highlightLogHtml(collapse(content, 800));
      return `<div class="tap-block ${cls}"><span class="tap-tool-label">${prefix}</span>: ${rendered}</div>`;
    }
    const json = truncateKeepNewlines(JSON.stringify(content, null, 2), 4000);
    return `<div class="tap-block ${cls}"><span class="tap-tool-label">${prefix}</span>: <pre class="tap-json">${escapeHtml(json)}</pre></div>`;
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

module.exports = { countLines, readEntries, readTailEntries, getModel, getTokenStats, getCompactionStats, renderEntryHtml };
