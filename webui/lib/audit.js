"use strict";
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

function dbPath() {
  const home = process.env.CC_MONITOR_HOME || path.join(os.homedir(), ".cc-monitor");
  return path.join(home, "events.db");
}

// 判断一条 Bash 命令里是不是真的在删文件——按 ; & | 换行 切成子命令分别看开头，
// 而不是对整条命令文本做子串匹配。之前用 SQL LIKE '%rm %' 之类的写法会把
// "confirm "/"warm "/"term " 这些词尾带 "rm " 的普通输出也算成删除，
// 或者把 echo 出来的字符串（比如 echo "rm -rf 很危险"）也算成真的删除，误报非常多。
function commandDeletesFiles(cmd) {
  if (!cmd) return false;
  // find -exec rm ... \; / cmd | xargs rm 这类不在子命令开头，单独兜底判断一下。
  if (/(?:^|\s)(?:-exec\s+|xargs\s+(?:-\S+\s+)*)(?:rm|shred|unlink)\b/.test(cmd)) return true;
  const segments = cmd.split(/[;&|\n]+/);
  for (const raw of segments) {
    const seg = raw.trim().replace(/^sudo\s+/, "");
    if (/^(rm|rmdir|unlink|shred|trash-put|trash)\b/.test(seg)) return true;
    if (/^git\s+rm\b/.test(seg)) return true;
    if (/^find\b/.test(seg) && /(?:^|\s)-delete(?:\s|$)/.test(seg)) return true;
  }
  return false;
}

function isDeleteEvent(detailJson) {
  try {
    const detail = detailJson ? JSON.parse(detailJson) : {};
    return commandDeletesFiles(detail.command || "") ? 1 : 0;
  } catch (e) {
    return 0;
  }
}

function withDb(fn, fallback) {
  let db;
  try {
    db = new Database(dbPath(), { readonly: true, fileMustExist: true });
    db.function("cc_is_delete", isDeleteEvent);
    return fn(db);
  } catch (e) {
    return fallback;
  } finally {
    if (db) db.close();
  }
}

// `transcript_path` 列是 cc_monitor/storage.py 那边升级后才懒加载 ALTER TABLE 加上的
// （见 storage.py 的 `_connect()`），旧数据库在第一次跑新版 hook 之前还没有这一列。
// Node 这边是只读连接，不能自己补列，所以查询前先探测一下，没有就优雅降级。
function hasTranscriptColumn(db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(events)`).all();
    return cols.some((c) => c.name === "transcript_path");
  } catch (e) {
    return false;
  }
}

function listSessions(limit = 200) {
  return withDb((db) => {
    const withTranscript = hasTranscriptColumn(db);
    return db
      .prepare(
        `SELECT session_id, cwd, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS event_count,
                SUM(CASE WHEN decision = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
                SUM(CASE WHEN matched_rule = 'hook_bypass_suspected' THEN 1 ELSE 0 END) AS bypass_count
                ${withTranscript ? ", MAX(transcript_path) AS transcript_path" : ""}
         FROM events
         WHERE session_id IS NOT NULL AND session_id != ''
         GROUP BY session_id
         ORDER BY last_ts DESC
         LIMIT ?`
      )
      .all(limit);
  }, []);
}

function getTranscriptPath(sessionId) {
  return withDb((db) => {
    if (!hasTranscriptColumn(db)) return null;
    const row = db
      .prepare(
        `SELECT transcript_path FROM events
         WHERE session_id = ? AND transcript_path IS NOT NULL AND transcript_path != ''
         ORDER BY id DESC LIMIT 1`
      )
      .get(sessionId);
    return row ? row.transcript_path : null;
  }, null);
}

function queryEvents({ sessionId, sinceId = 0, limit = 300 } = {}) {
  return withDb((db) => {
    let sql = `SELECT id, ts, session_id, source, tool_name, cwd, risk, matched_rule, decision, detail
               FROM events WHERE id > ?`;
    const params = [sinceId];
    if (sessionId) {
      sql += ` AND session_id = ?`;
      params.push(sessionId);
    }
    sql += ` ORDER BY id ASC LIMIT ?`;
    params.push(limit);
    return db.prepare(sql).all(...params);
  }, []);
}

function stats() {
  return withDb((db) => {
    const byRisk = db.prepare(`SELECT risk, COUNT(*) AS n FROM events GROUP BY risk`).all();
    const byDecision = db.prepare(`SELECT decision, COUNT(*) AS n FROM events GROUP BY decision`).all();
    const bySource = db.prepare(`SELECT source, COUNT(*) AS n FROM events GROUP BY source`).all();
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n;
    const sessionCount = db
      .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE session_id IS NOT NULL AND session_id != ''`)
      .get().n;
    const blockedTotal = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE decision = 'blocked'`).get().n;
    const bypassTotal = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE matched_rule = 'hook_bypass_suspected'`)
      .get().n;
    return { total, sessionCount, blockedTotal, bypassTotal, byRisk, byDecision, bySource };
  }, { total: 0, sessionCount: 0, blockedTotal: 0, bypassTotal: 0, byRisk: [], byDecision: [], bySource: [] });
}

// 文件读/写/编辑/删除次数——删除没有专门的工具（Claude Code 没有内置"删文件"工具），
// 靠解析 Bash 命令文本（只看 detail.command 字段本身，按 ; & | 拆成子命令再看开头是不是
// rm/rmdir/unlink/shred/git rm/find -delete 等）来识别，见上面 commandDeletesFiles()。
// 不是 100% 精确（比如 $() 命令替换里的删除识别不到），但比之前的整串 LIKE 子串匹配准确得多。
const DELETE_CLAUSE = `source = 'hook_pre' AND tool_name = 'Bash' AND cc_is_delete(detail) = 1`;

function fileOpsStats() {
  return withDb((db) => {
    const countTool = (names) => {
      const placeholders = names.map(() => "?").join(",");
      return db
        .prepare(
          `SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name IN (${placeholders})`
        )
        .get(...names).n;
    };
    const reads = countTool(["Read"]);
    const writes = countTool(["Write"]);
    const edits = countTool(["Edit", "MultiEdit", "NotebookEdit"]);
    const deletes = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${DELETE_CLAUSE}`).get().n;
    return { reads, writes, edits, deletes };
  }, { reads: 0, writes: 0, edits: 0, deletes: 0 });
}

const FILE_OP_TOOLS = {
  read: ["Read"],
  write: ["Write"],
  edit: ["Edit", "MultiEdit", "NotebookEdit"],
};

// 首页文件操作卡片（读/写/编辑/删除）的下钻详情：具体是哪些事件。
function fileOpDetails(type, limit = 300) {
  return withDb((db) => {
    if (type === "delete") {
      return db
        .prepare(`SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events WHERE ${DELETE_CLAUSE} ORDER BY id DESC LIMIT ?`)
        .all(limit);
    }
    const tools = FILE_OP_TOOLS[type];
    if (!tools) return [];
    const placeholders = tools.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND tool_name IN (${placeholders})
         ORDER BY id DESC LIMIT ?`
      )
      .all(...tools, limit);
  }, []);
}

// 软件安装统计——不用另外写识别逻辑，直接复用 policy 规则引擎已经判过的 matched_rule
// 分组就行（pip/系统包管理器/npm/其它这几类规则本来就在 default_rules.json 里维护着，
// 识别逻辑只有一份，不会跟 policy 那边判断的标准不一致）。
const INSTALL_RULE_GROUPS = {
  pip: ["sudo_pip_install", "pip_install_venv_context", "pip_install_no_venv"],
  system: ["system_package_install"],
  npm: ["npm_global_install"],
  other: ["package_install_other"],
};

function installStats() {
  return withDb((db) => {
    const countRules = (rules) => {
      const placeholders = rules.map(() => "?").join(",");
      return db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND matched_rule IN (${placeholders})`)
        .get(...rules).n;
    };
    return {
      pip: countRules(INSTALL_RULE_GROUPS.pip),
      system: countRules(INSTALL_RULE_GROUPS.system),
      npm: countRules(INSTALL_RULE_GROUPS.npm),
      other: countRules(INSTALL_RULE_GROUPS.other),
    };
  }, { pip: 0, system: 0, npm: 0, other: 0 });
}

// 首页软件安装统计卡片（pip/系统包/npm/其它）的下钻详情：具体是哪些安装指令。
function installDetails(type, limit = 300) {
  const rules = INSTALL_RULE_GROUPS[type];
  if (!rules) return [];
  return withDb((db) => {
    const placeholders = rules.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND matched_rule IN (${placeholders})
         ORDER BY id DESC LIMIT ?`
      )
      .all(...rules, limit);
  }, []);
}

// 工具调用统计——"审计事件总数"是 hook_pre + hook_post + os_net 全部加一起的，
// 同一次工具调用至少算两条（pre 一条、post 一条），这里只数 hook_pre，对应的是
// "Claude Code 真的发起过多少次工具调用"这个更直观的数字。
function toolCallStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre'`).get().n;
    return { total };
  }, { total: 0 });
}

// 首页"工具调用"卡片下钻：按工具名分组的次数明细（不是每条事件平铺列出来——
// 光是"调用过多少次 Bash"这种数字，比翻一屏事件列表更有信息量）。
function toolCallBreakdown(limit = 100) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT tool_name, COUNT(*) AS n FROM events
         WHERE source = 'hook_pre'
         GROUP BY tool_name ORDER BY n DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// MCP 工具调用——Claude Code 给 MCP server 提供的工具统一命名成
// `mcp__<server>__<tool>` 这个格式，不用另外维护一份 MCP server 列表，直接按
// tool_name 前缀识别就行。
const MCP_TOOL_PATTERN = "mcp\\_\\_%";

function mcpCallStats() {
  return withDb((db) => {
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name LIKE ? ESCAPE '\\'`)
      .get(MCP_TOOL_PATTERN).n;
    return { total };
  }, { total: 0 });
}

// 首页"MCP 调用"卡片下钻：按 MCP server 分组（从 tool_name 里 mcp__<server>__<tool>
// 这个约定格式解析出 server 名字），而不是按具体工具名——同一个 server 底下可能有
// 十几个工具，按 server 汇总更容易看出"到底在跟哪个 MCP 服务打交道"。
function mcpCallBreakdown(limit = 100) {
  return withDb((db) => {
    const rows = db
      .prepare(`SELECT tool_name, COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name LIKE ? ESCAPE '\\' GROUP BY tool_name`)
      .all(MCP_TOOL_PATTERN);
    const byServer = new Map();
    for (const r of rows) {
      const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(r.tool_name);
      const server = m ? m[1] : r.tool_name;
      byServer.set(server, (byServer.get(server) || 0) + r.n);
    }
    return [...byServer.entries()]
      .map(([server, n]) => ({ server, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, limit);
  }, []);
}

// Skill 调用——跟 MCP 调用同一个思路，只是分组用的不是 tool_name 前缀，而是
// tool_input 里的 skill 字段本身（`Skill` 这个工具名固定不变，具体调用的是哪个
// skill 全在 detail.skill 里）。SQLite 自带的 json_extract 直接在 SQL 里取，
// 不用先把每一行 detail 都读出来在 JS 里 JSON.parse 一遍。
function skillCallStats() {
  return withDb((db) => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'hook_pre' AND tool_name = 'Skill'`).get().n;
    return { total };
  }, { total: 0 });
}

function skillCallBreakdown(limit = 100) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT COALESCE(json_extract(detail, '$.skill'), '?') AS skill, COUNT(*) AS n
         FROM events WHERE source = 'hook_pre' AND tool_name = 'Skill'
         GROUP BY skill ORDER BY n DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// 工具调用/MCP 调用卡片下钻里点进某个具体工具名之后的事件明细，跟 fileOpDetails/
// installDetails 是同一个套路。
function toolCallDetails(toolName, limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail FROM events
         WHERE source = 'hook_pre' AND tool_name = ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(toolName, limit);
  }, []);
}

// 工具调用/MCP 调用/Skill 调用这三张卡片下钻的"事件明细"部分——按工具名分组的次数
// 只能看出"用得多不多"，看不出"具体是哪个 session、哪个目录、什么时候调用的"，
// 这三个函数专门补这块：平铺列出最近的事件，带 Session ID/cwd/时间戳。
function toolCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(`SELECT id, ts, session_id, cwd, tool_name FROM events WHERE source = 'hook_pre' ORDER BY id DESC LIMIT ?`)
      .all(limit);
  }, []);
}

function mcpCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name FROM events
         WHERE source = 'hook_pre' AND tool_name LIKE ? ESCAPE '\\'
         ORDER BY id DESC LIMIT ?`
      )
      .all(MCP_TOOL_PATTERN, limit);
  }, []);
}

function skillCallEvents(limit = 300) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, COALESCE(json_extract(detail, '$.skill'), '?') AS skill FROM events
         WHERE source = 'hook_pre' AND tool_name = 'Skill'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

// AI 轨迹卡片下钻的事件明细部分——跟上面三个不一样：这些数据来自系统层探针的
// CONNECT 观测（source='os_net'），探针只在内核层面看到 pid/uid，天生不知道
// "这属于 Claude Code 的哪个 session"，所以 session_id/cwd 在这张表里永远是空的，
// 不是查询漏了字段——前端要如实显示"不可用"，不能编一个假的出来。能给的是
// 时间戳和 pid（探针观测到的进程号，勉强算是"哪个进程"的线索）。
function networkConnectEvents(limit = 300) {
  return withDb((db) => {
    const rows = db
      .prepare(`SELECT id, ts, tool_name, detail FROM events WHERE source = 'os_net' ORDER BY id DESC LIMIT ?`)
      .all(limit);
    return rows.map((r) => {
      let detail = {};
      try {
        detail = r.detail ? JSON.parse(r.detail) : {};
      } catch (e) {
        detail = {};
      }
      return { id: r.id, ts: r.ts, comm: r.tool_name, pid: detail.pid, ip: detail.ip, port: detail.port, host: detail.host };
    });
  }, []);
}

// "审计事件总数"下钻：按 工具/来源 分组，并且列出每个分组具体是哪些 session 产生的。
function eventTypeBreakdown(limit = 500) {
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT source, tool_name, session_id, COUNT(*) AS n
         FROM events
         GROUP BY source, tool_name, session_id
         ORDER BY n DESC`
      )
      .all();
    const byType = new Map();
    for (const r of rows) {
      const key = `${r.source}::${r.tool_name || ""}`;
      if (!byType.has(key)) {
        byType.set(key, { source: r.source, toolName: r.tool_name, total: 0, sessions: [] });
      }
      const entry = byType.get(key);
      entry.total += r.n;
      if (r.session_id) entry.sessions.push({ sessionId: r.session_id, count: r.n });
    }
    return [...byType.values()].sort((a, b) => b.total - a.total).slice(0, limit);
  }, []);
}

// "拦截的高危操作"下钻：具体是哪些命令/操作被挡下来的。
function blockedDetails(limit = 200) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT id, ts, session_id, cwd, tool_name, matched_rule, detail
         FROM events WHERE decision = 'blocked'
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }, []);
}

module.exports = {
  listSessions,
  queryEvents,
  stats,
  dbPath,
  getTranscriptPath,
  fileOpsStats,
  fileOpDetails,
  installStats,
  installDetails,
  toolCallStats,
  toolCallBreakdown,
  mcpCallStats,
  mcpCallBreakdown,
  skillCallStats,
  skillCallBreakdown,
  toolCallDetails,
  toolCallEvents,
  mcpCallEvents,
  skillCallEvents,
  networkConnectEvents,
  eventTypeBreakdown,
  blockedDetails,
};
