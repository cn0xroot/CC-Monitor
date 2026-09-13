"use strict";
const Database = require("better-sqlite3");
const { dbPath } = require("./audit");

// action=confirm 的操作在 hook 那边（cc_monitor/notify.py）会一直等着——同时开两条路：
// 触发它的那个终端里可以直接按 y/N，这里的"待批准"页面也能点。这个模块只负责读/写
// 同一张 pending_approvals 表，不是 readonly（跟 audit.js 那些查询用的连接不一样，
// 这里要写）。
function withDb(fn, fallback) {
  let db;
  try {
    db = new Database(dbPath(), { fileMustExist: true, timeout: 5000 });
    return fn(db);
  } catch (e) {
    return fallback;
  } finally {
    if (db) db.close();
  }
}

function listPending() {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, tool_name, cwd, matched_rule, matched_value, risk, status
         FROM pending_approvals WHERE status = 'pending' ORDER BY id ASC`
      )
      .all();
  }, []);
}

const DECISION_TO_STATUS = {
  allow: "allowed",
  deny: "denied",
  always_allow: "always_allowed",
  allow_10m: "allowed_10m",
  allow_30m: "allowed_30m",
};

// 跟 cc_monitor/storage.py 的 resolve_approval() 是同一张表、同一套"谁先写谁算数"
// 规则——WHERE status='pending' 保证不会跟终端那边刚好同时按/敲的结果打架。
function resolve(id, decision) {
  const status = DECISION_TO_STATUS[decision];
  if (!status) return { ok: false, error: "decision 必须是 allow / deny / always_allow / allow_10m / allow_30m 之一" };
  return withDb((db) => {
    const info = db
      .prepare(`UPDATE pending_approvals SET status = ?, resolved_at = ?, resolved_via = 'web' WHERE id = ? AND status = 'pending'`)
      .run(status, new Date().toISOString(), id);
    if (info.changes === 0) return { ok: false, error: "这条请求已经被处理过了（可能是在触发它的终端里已经回答了）" };
    return { ok: true, status };
  }, { ok: false, error: "数据库不可写" });
}

module.exports = { listPending, resolve };
