"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { dbPath } = require("./audit");

const RECENT_MS = 15 * 60 * 1000; // 15 分钟内写过 transcript 就算"最近有活动"

function claudeProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

// 扫 ~/.claude/projects/*/*.jsonl（不进 subagents/ 子目录，那些是子代理自己的记录，
// 不代表一个独立的 Claude Code 会话），找最近被写过的 transcript 文件。
function findRecentTranscripts(withinMs) {
  const dir = claudeProjectsDir();
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  const results = [];
  for (const projDir of fs.readdirSync(dir)) {
    const full = path.join(dir, projDir);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(full, f);
      let st;
      try {
        st = fs.statSync(fp);
      } catch (e) {
        continue;
      }
      if (!st.isFile()) continue;
      if (now - st.mtimeMs <= withinMs) {
        results.push({ sessionId: f.replace(/\.jsonl$/, ""), transcriptPath: fp, mtimeMs: st.mtimeMs });
      }
    }
  }
  return results;
}

// 找出"transcript 最近确实被写过（说明这个 Claude Code 会话正在被使用），但审计库里
// 一条它的事件都没有"的会话——这不是计数算错了，是 Claude Code 的 hooks 配置只在会话
// 启动那一刻加载一次、不会中途热更新：这种会话大概率是在 CC-Monitor 代码/hooks 配置
// 更新之前就已经启动的，还在用启动那一刻的旧配置，我们没法从外部强制它重新加载，
// 唯一的办法是退出重开这个会话（重新执行一次 claude / claude --resume）。
function findUnmonitoredActiveSessions() {
  const recent = findRecentTranscripts(RECENT_MS);
  if (recent.length === 0) return [];
  let db;
  try {
    db = new Database(dbPath(), { readonly: true, fileMustExist: true });
    const known = new Set(
      db
        .prepare(`SELECT DISTINCT session_id FROM events WHERE session_id IS NOT NULL AND session_id != ''`)
        .all()
        .map((r) => r.session_id)
    );
    return recent
      .filter((r) => !known.has(r.sessionId))
      .map((r) => ({
        sessionId: r.sessionId,
        transcriptPath: r.transcriptPath,
        lastActivity: new Date(r.mtimeMs).toISOString(),
      }))
      .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  } catch (e) {
    return [];
  } finally {
    if (db) db.close();
  }
}

module.exports = { findUnmonitoredActiveSessions };
