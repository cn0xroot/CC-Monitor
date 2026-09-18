"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { dbPath } = require("./audit");
const agentsRegistry = require("./agents");

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

// 其它 agent：按注册表 sessions.glob 找最近写过的会话文件。会话 id 的取法各家不同：
//   claude   <session>.jsonl 的文件名
//   antigravity   brain/<conversationId>/.system_generated/logs/transcript.jsonl 里的目录名
//   codex    rollout-<时间>-<uuid>.jsonl 末尾的 uuid
//   其它     文件名去掉扩展名
function sessionIdFromPath(agent, fp) {
  const base = path.basename(fp);
  if (agent.sessionsFormat === "antigravity_transcript") {
    const m = /\/brain\/([^/]+)\//.exec(fp);
    return m ? m[1] : base;
  }
  if (agent.sessionsFormat === "codex_rollout") {
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(base);
    return m ? m[1] : base.replace(/\.jsonl$/, "");
  }
  return base.replace(/\.(jsonl|json)$/, "");
}

function findRecentOtherAgentTranscripts(withinMs) {
  const now = Date.now();
  const results = [];
  for (const agent of agentsRegistry.list()) {
    if (agent.id === "claude-code" || !agent.sessionsGlob || !agent.sessionsGlob.endsWith("l")) continue; // 只扫 .jsonl（.db/.json 不是逐行 transcript）
    let files = [];
    try {
      files = agentsRegistry.expandGlob(agent.sessionsGlob);
    } catch (e) {
      continue;
    }
    for (const fp of files) {
      if (/transcript_full\.jsonl$/.test(fp)) continue; // Antigravity 的 _full 是同一会话的加长版，只算一份
      let st;
      try {
        st = fs.statSync(fp);
      } catch (e) {
        continue;
      }
      if (now - st.mtimeMs <= withinMs) {
        results.push({ sessionId: sessionIdFromPath(agent, fp), transcriptPath: fp, mtimeMs: st.mtimeMs, agent: agent.id });
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
  const recent = findRecentTranscripts(RECENT_MS).map((r) => ({ ...r, agent: "claude-code" })).concat(findRecentOtherAgentTranscripts(RECENT_MS));
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
        agent: r.agent,
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
