"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { dbPath } = require("./audit");

// 归档做的事情：把"当前"这份 events.db 用 SQLite 官方的 backup API 完整备份一份到
// archives/ 目录下（backup() 内部会处理 WAL checkpoint，不会漏掉还没落盘的数据，
// 也不用停掉正在写入的 hooks），再顺手统计一下这份快照里有多少事件/会话/时间范围，
// 写一个同名 .json 元数据文件方便"历史数据记录列表"直接读，不用每次都打开 db 文件。
function archivesDir() {
  return path.join(path.dirname(dbPath()), "archives");
}

function statsFromDb(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n;
    const sessionCount = db
      .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE session_id IS NOT NULL AND session_id != ''`)
      .get().n;
    const range = db.prepare(`SELECT MIN(ts) AS firstTs, MAX(ts) AS lastTs FROM events`).get();
    return { total, sessionCount, firstTs: range.firstTs || null, lastTs: range.lastTs || null };
  } finally {
    db.close();
  }
}

async function createArchive(label) {
  const src = dbPath();
  if (!fs.existsSync(src)) {
    return { ok: false, error: "还没有任何事件数据，无法归档" };
  }
  const dir = archivesDir();
  fs.mkdirSync(dir, { recursive: true });

  const ts = new Date();
  const stamp = ts.toISOString().replace(/[:.]/g, "-");
  const fileName = `${stamp}.db`;
  const destFile = path.join(dir, fileName);

  const srcDb = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await srcDb.backup(destFile);
  } finally {
    srcDb.close();
  }

  // 备份出来的文件会继承源库的 WAL 日志模式，本身会带上 -wal/-shm 这两个附属文件。
  // 归档是不会再被写入的快照，没必要留着 WAL；转成普通日志模式让它变成单个自包含的
  // .db 文件，之后删除归档时也不用惦记着还有没有漏删的附属文件。
  const convertDb = new Database(destFile);
  try {
    convertDb.pragma("journal_mode = DELETE");
  } finally {
    convertDb.close();
  }

  const stats = statsFromDb(destFile);
  if (stats.total === 0) {
    // 没有数据的话不留一个空归档，把刚备份出来的空文件也清掉。
    fs.unlinkSync(destFile);
    return { ok: false, error: "没有事件数据，无法归档" };
  }

  const meta = {
    id: stamp,
    label: label || "",
    file: fileName,
    createdAt: ts.toISOString(),
    ...stats,
  };
  fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(meta, null, 2));
  return { ok: true, archive: meta };
}

function listArchives() {
  const dir = archivesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function deleteArchive(id) {
  const dir = archivesDir();
  const meta = listArchives().find((a) => a.id === id);
  if (!meta) return { ok: false, error: "归档不存在" };
  for (const f of [meta.file, `${meta.file}-wal`, `${meta.file}-shm`, `${id}.json`]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return { ok: true };
}

// 打开一份历史归档，翻看里面具体是哪些事件——只读，不会碰当前的 events.db。
// 支持 sinceId 增量翻页，归档里事件多的时候前端可以做"加载更多"而不是一次性全读出来。
function getArchiveEvents(id, { sinceId = 0, limit = 500 } = {}) {
  const dir = archivesDir();
  const meta = listArchives().find((a) => a.id === id);
  if (!meta) return null;
  const file = path.join(dir, meta.file);
  if (!fs.existsSync(file)) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT id, ts, session_id, source, tool_name, cwd, risk, matched_rule, decision, detail
         FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`
      )
      .all(sinceId, limit);
  } finally {
    db.close();
  }
}

// 清空"当前"事件数据——不是归档,是真的丢弃。用可写连接对同一个 events.db 操作，
// DELETE 之后把 AUTOINCREMENT 计数器也重置一下，这样清空后新事件的 id 重新从 1 开始，
// 首页/日志页看着更干净，不会突然从一个很大的 id 跳出来。
function clearCurrentEvents() {
  const src = dbPath();
  if (!fs.existsSync(src)) return { ok: true, deletedCount: 0 };
  const db = new Database(src, { fileMustExist: true, timeout: 5000 });
  try {
    const before = db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n;
    db.exec(`DELETE FROM events;`);
    db.exec(`DELETE FROM sqlite_sequence WHERE name = 'events';`);
    return { ok: true, deletedCount: before };
  } finally {
    db.close();
  }
}

module.exports = { archivesDir, createArchive, listArchives, deleteArchive, clearCurrentEvents, getArchiveEvents };
