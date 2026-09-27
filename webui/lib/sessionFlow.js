"use strict";
// 把一个会话的原始审计事件组装成"操作流程图"：按用户提问切成一轮一轮，每轮里是按
// 时间先后排的操作节点；每个操作节点 = 一次工具调用的"准备执行(hook_pre)"和"执行
// 完成(hook_post)"两条记录合并而成，并判定这次操作最终成功还是失败。
//
// 成败怎么判定——Claude Code 的 PostToolUse hook 只在工具执行成功时才触发（报错、
// 被用户拒绝、被中断时不触发），所以：
//   - 有 hook_post：执行成功；再看返回内容里有没有中断/超时/HTTP 错误码/success=false
//     这类"工具本身跑完了但结果是失败"的标记，以及 Bash 有没有 stderr 输出。
//   - 只有 hook_pre、没有 hook_post：要么被我们的规则拦截（decision=blocked），要么
//     还在跑（会话最近还活跃、这一轮还没结束），否则就是执行失败/被拒绝/被中断。
// hook 记录里没有 tool_use_id，只能按"同一个工具、输入参数完全相同、先进先出"配对
// ——hook_post 里原样带了一份 input，跟 hook_pre 的 detail 是同一个对象。
const fmt = require("./format");

const RUNNING_WINDOW_MS = 10 * 60 * 1000;
const GROUP_MIN = 3;
const RISK_RANK = { high: 4, medium: 3, low: 2, info: 1, "-": 0 };
const QUIET_RISKS = new Set(["info", "low", "-", null, undefined, ""]);
const TOOL_EVENT_SOURCES = new Set(["hook_pre", "hook_post"]);
const OS_SOURCES = new Set(["os_exec", "os_net", "os_file", "os_listen"]);

function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}

function parseDetail(row) {
  try {
    return row.detail ? JSON.parse(row.detail) : {};
  } catch (e) {
    return {};
  }
}

function tsMs(ts) {
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function worseRisk(a, b) {
  return (RISK_RANK[a] || 0) >= (RISK_RANK[b] || 0) ? a : b;
}

// 有 hook_post 时：工具跑完了，看返回内容判断结果。
function postStatus(tool, resp) {
  if (!resp || typeof resp !== "object") return { status: "ok" };
  if (resp.success === false) return { status: "fail", reason: "reported", detail: String(resp.message || "").slice(0, 200) };
  if (tool === "Bash") {
    if (resp.interrupted) return { status: "fail", reason: "interrupted" };
    if (resp.timedOutAfterMs) return { status: "fail", reason: "timeout", detail: String(resp.timedOutAfterMs) };
    if (resp.backgroundTaskId) return { status: "background" };
    const stderr = String(resp.stderr || "").trim();
    if (stderr) return { status: "warn", reason: "stderr", detail: stderr.slice(-200) };
    return { status: "ok" };
  }
  if (tool === "WebFetch" && typeof resp.code === "number" && resp.code >= 400) {
    return { status: "fail", reason: "http", detail: `${resp.code} ${resp.codeText || ""}`.trim() };
  }
  if ((tool === "Agent" || tool === "Task") && resp.isAsync) return { status: "background" };
  return { status: "ok" };
}

function makeOpNode({ pre, post, preDetail, postDetail }) {
  const base = pre || post;
  const tool = base.tool_name;
  const describeFrom = post ? { source: "hook_post", detail: postDetail } : { source: base.source, detail: preDetail };
  const d = fmt.describe(tool, describeFrom.source, describeFrom.detail);
  const node = {
    id: base.id,
    type: "op",
    tool,
    source: base.source,
    label: d.label,
    summaryHtml: d.summaryHtml,
    extra: d.extra,
    startTs: base.ts,
    endTs: post ? post.ts : null,
    durationMs: null,
    risk: pre && post ? worseRisk(pre.risk, post.risk) : base.risk,
    matchedRule: (pre && pre.matched_rule) || (post && post.matched_rule) || null,
    decision: pre ? pre.decision : post.decision,
    branch: tool === "Agent" || tool === "Task",
    eventIds: [pre && pre.id, post && post.id].filter(Boolean),
  };
  if (pre && post) {
    const a = tsMs(pre.ts);
    const b = tsMs(post.ts);
    if (a !== null && b !== null) node.durationMs = Math.max(0, b - a);
  }
  if (post) {
    Object.assign(node, postStatus(tool, postDetail && postDetail.response));
  } else if (pre && pre.decision === "blocked") {
    node.status = "blocked";
  } else {
    node.status = "pending"; // 暂定，等整轮看完再决定是"进行中"还是"未完成"
  }
  return node;
}

function makeOsNode(row, detail) {
  const d = fmt.describe(row.tool_name, row.source, detail);
  const warn = (d.extra || []).some((e) => e.cls === "warn");
  return {
    id: row.id,
    type: "observe",
    tool: row.tool_name,
    source: row.source,
    label: d.label,
    summaryHtml: d.summaryHtml,
    extra: d.extra,
    startTs: row.ts,
    endTs: null,
    durationMs: null,
    risk: row.risk,
    matchedRule: row.matched_rule || null,
    decision: row.decision,
    status: warn ? "warn" : "observed",
    reason: warn ? "bypass" : undefined,
    branch: false,
    eventIds: [row.id],
  };
}

function makeLifecycleNode(row, detail) {
  const d = fmt.describe(row.tool_name, row.source, detail);
  return {
    id: row.id,
    type: "lifecycle",
    tool: row.tool_name,
    source: row.source,
    label: d.label,
    summaryHtml: d.summaryHtml,
    extra: d.extra,
    startTs: row.ts,
    endTs: null,
    durationMs: null,
    risk: row.risk,
    matchedRule: row.matched_rule || null,
    decision: row.decision,
    status: "info",
    branch: false,
    eventIds: [row.id],
  };
}

function newTurn(idx, promptRow, promptDetail) {
  return {
    idx,
    prompt: promptRow
      ? { id: promptRow.id, ts: promptRow.ts, text: String((promptDetail && promptDetail.prompt) || ""), risk: promptRow.risk, matchedRule: promptRow.matched_rule || null }
      : null,
    startTs: promptRow ? promptRow.ts : null,
    endTs: null,
    stopped: false,
    subagentStops: 0,
    sessionStart: null,
    nodes: [],
  };
}

// 连续 GROUP_MIN 条以上"同一个工具、低风险、都成功"的操作合并成一个节点，
// 避免 20 次连续 Read 把流程图拉得老长；明细保留在 items 里，前端可以展开。
function groupRuns(nodes) {
  const out = [];
  let i = 0;
  const groupable = (n) => n.type === "op" && !n.branch && n.status === "ok" && QUIET_RISKS.has(n.risk);
  while (i < nodes.length) {
    const n = nodes[i];
    if (!groupable(n)) {
      out.push(n);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < nodes.length && groupable(nodes[j]) && nodes[j].tool === n.tool) j++;
    if (j - i >= GROUP_MIN) {
      const items = nodes.slice(i, j);
      const last = items[items.length - 1];
      out.push({
        id: "g" + n.id,
        type: "group",
        tool: n.tool,
        label: n.label,
        summaryHtml: n.summaryHtml,
        count: items.length,
        startTs: n.startTs,
        endTs: last.endTs || last.startTs,
        durationMs: null,
        risk: items.reduce((r, x) => worseRisk(r, x.risk), "-"),
        status: "ok",
        branch: false,
        items,
      });
    } else {
      for (let k = i; k < j; k++) out.push(nodes[k]);
    }
    i = j;
  }
  return out;
}

function buildSessionFlow(rows, { now = Date.now(), group = true } = {}) {
  const turns = [];
  let turn = newTurn(0, null, null);
  const openPre = new Map(); // tool_name -> [{node, key}]
  let sessionStart = null;

  const pushTurn = () => {
    if (turn.prompt || turn.nodes.length || turn.sessionStart) turns.push(turn);
  };

  for (const row of rows) {
    const detail = parseDetail(row);
    if (row.source === "hook_prompt") {
      pushTurn();
      turn = newTurn(turns.length, row, detail);
      continue;
    }
    if (row.source === "hook_lifecycle") {
      if (row.tool_name === "Stop") {
        turn.stopped = true;
        turn.endTs = row.ts;
      } else if (row.tool_name === "SubagentStop") {
        turn.subagentStops++;
      } else if (row.tool_name === "SessionStart" && !turn.prompt && !turn.sessionStart) {
        // 第一次提问之前的 SessionStart 就是"会话开始"那张标题卡本身，不再单独画一张卡
        turn.sessionStart = { ts: row.ts, source: detail.source || null };
        if (!turn.startTs) turn.startTs = row.ts;
        if (!sessionStart) sessionStart = turn.sessionStart;
      } else {
        turn.nodes.push(makeLifecycleNode(row, detail));
      }
      continue;
    }
    if (OS_SOURCES.has(row.source)) {
      turn.nodes.push(makeOsNode(row, detail));
      continue;
    }
    if (!TOOL_EVENT_SOURCES.has(row.source)) continue;

    if (row.source === "hook_pre") {
      const node = makeOpNode({ pre: row, post: null, preDetail: detail, postDetail: null });
      node._pre = row;
      node._preDetail = detail;
      node._turn = turn;
      turn.nodes.push(node);
      // 被拦截的不会有 hook_post，不进待配对队列——否则之后原样重试的那次的 post
      // 会被错配到这条被拦截的记录上
      if (row.decision !== "blocked") {
        if (!openPre.has(row.tool_name)) openPre.set(row.tool_name, []);
        openPre.get(row.tool_name).push({ node, key: canonical(detail) });
      }
      continue;
    }

    // hook_post：找输入参数完全相同的 pre 里最近的一条（失败过又原样重试时，post 属于
    // 重试那次，不是之前失败的那次）；找不到再退回同名工具里最近的一条
    const queue = openPre.get(row.tool_name) || [];
    const key = canonical(detail.input || {});
    let idx = queue.findLastIndex((q) => q.key === key);
    if (idx === -1 && queue.length) idx = queue.length - 1;
    if (idx !== -1) {
      const { node } = queue.splice(idx, 1)[0];
      const merged = makeOpNode({ pre: node._pre, post: row, preDetail: node._preDetail, postDetail: detail });
      merged._turn = node._turn;
      const list = node._turn.nodes;
      list[list.indexOf(node)] = merged;
    } else {
      const orphan = makeOpNode({ pre: null, post: row, preDetail: null, postDetail: detail });
      turn.nodes.push(orphan);
    }
  }
  pushTurn();

  // 没等到 hook_post 的操作：这一轮还没结束、而且会话最近还活跃 → 进行中；否则就是没成功。
  const lastRow = rows[rows.length - 1];
  const lastMs = lastRow ? tsMs(lastRow.ts) : null;
  const sessionRecent = lastMs !== null && now - lastMs < RUNNING_WINDOW_MS;
  const lastTurn = turns[turns.length - 1];
  for (const t of turns) {
    for (const n of t.nodes) {
      if (n.status === "pending") {
        const live = t === lastTurn && !t.stopped && sessionRecent;
        n.status = live ? "running" : "fail";
        if (!live) n.reason = "noresult";
      }
      delete n._pre;
      delete n._preDetail;
      delete n._turn;
    }
    const stats = { ok: 0, warn: 0, fail: 0, blocked: 0, running: 0, background: 0, total: 0 };
    for (const n of t.nodes) {
      if (n.type !== "op") continue;
      stats.total++;
      if (stats[n.status] !== undefined) stats[n.status]++;
    }
    t.stats = stats;
    if (!t.endTs && t.nodes.length) {
      const lastNode = t.nodes[t.nodes.length - 1];
      t.endTs = lastNode.endTs || lastNode.startTs;
    }
    if (!t.startTs && t.nodes.length) t.startTs = t.nodes[0].startTs;
    if (group) t.nodes = groupRuns(t.nodes);
  }

  return {
    sessionStart,
    firstTs: rows.length ? rows[0].ts : null,
    lastTs: lastRow ? lastRow.ts : null,
    live: sessionRecent,
    turns,
  };
}

module.exports = { buildSessionFlow, postStatus, canonical };
