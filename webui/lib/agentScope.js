"use strict";
// 多 agent：把"当前请求只看哪家 agent"带进数据层，让所有现成的 SQL 自动只查那一家。
//
// 做法不是逐条改几十个查询，而是在 better-sqlite3 的 prepare() 上套一层：请求带了
// ?agent=<id> 时，SQL 里的 `FROM events`（以及 `FROM pending_approvals`）被改写成
// `FROM (SELECT * FROM events WHERE agent = '<id>') AS events`——一个同名子查询，后面的
// WHERE / GROUP BY / 列名全都原样成立。请求上下文用 AsyncLocalStorage 传，express 路由里
// 有 await 也不会串到别的请求。
//
// 不改写的情况：没带 agent、agent 不合法（只认 [a-z0-9_-]）、老库还没有 agent 列、
// 以及 /api/agents 这种本来就要按 agent 分组的查询（它的 SQL 里带 "GROUP BY agent"）。
const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();
const SAFE_ID = /^[a-z0-9_-]{1,64}$/;

function middleware(req, res, next) {
  const raw = typeof req.query.agent === "string" ? req.query.agent.trim() : "";
  als.run({ agent: SAFE_ID.test(raw) ? raw : null }, () => next());
}

function current() {
  const store = als.getStore();
  return store && store.agent ? store.agent : null;
}

const columnCache = new Map(); // dbPath -> {events: bool, pending: bool, at}

function tableHasAgent(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === "agent");
  } catch (e) {
    return false;
  }
}

function rewrite(sql, agent, hasEventsAgent, hasPendingAgent) {
  if (/GROUP BY\s+agent\b/i.test(sql)) return sql; // 按 agent 分组的汇总本来就要看全部
  let out = sql;
  if (hasEventsAgent) {
    out = out.replace(/\bFROM\s+events\b(?!\s*\()(\s+(?:AS\s+)?(?!WHERE\b|GROUP\b|ORDER\b|LIMIT\b|JOIN\b|LEFT\b|INNER\b|ON\b|SET\b)([A-Za-z_]\w*))?/gi,
      (m, aliasPart, alias) => `FROM (SELECT * FROM events WHERE agent = '${agent}') AS ${alias || "events"}`);
  }
  if (hasPendingAgent) {
    out = out.replace(/\bFROM\s+pending_approvals\b(?!\s*\()(\s+(?:AS\s+)?(?!WHERE\b|GROUP\b|ORDER\b|LIMIT\b|JOIN\b|SET\b)([A-Za-z_]\w*))?/gi,
      (m, aliasPart, alias) => `FROM (SELECT * FROM pending_approvals WHERE agent = '${agent}') AS ${alias || "pending_approvals"}`);
  }
  return out;
}

// 给一个已打开的 better-sqlite3 连接套上改写层。没有作用域时原样返回，零开销。
function scope(db, key) {
  const agent = current();
  if (!agent) return db;
  let cols = columnCache.get(key);
  if (!cols || Date.now() - cols.at > 60 * 1000) {
    cols = { events: tableHasAgent(db, "events"), pending: tableHasAgent(db, "pending_approvals"), at: Date.now() };
    columnCache.set(key, cols);
  }
  if (!cols.events && !cols.pending) return db;
  const orig = db.prepare.bind(db);
  db.prepare = (sql) => orig(rewrite(sql, agent, cols.events, cols.pending));
  return db;
}

module.exports = { middleware, current, scope, rewrite };
