import json
import os
import sqlite3
import time
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("CC_MONITOR_HOME", str(Path.home() / ".cc-monitor")))
DB_PATH = CONFIG_DIR / "events.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    session_id TEXT,
    source TEXT,
    tool_name TEXT,
    cwd TEXT,
    risk TEXT,
    matched_rule TEXT,
    decision TEXT,
    detail TEXT
);
"""


def _connect():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=5)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute(SCHEMA)
    try:
        conn.execute("ALTER TABLE events ADD COLUMN transcript_path TEXT")
    except sqlite3.OperationalError:
        pass  # 列已经存在（老数据库升级过一次之后）
    return conn


def log_event(session_id, source, tool_name, detail, cwd, risk, matched_rule, decision, transcript_path=None):
    conn = _connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO events "
                "(ts, session_id, source, tool_name, cwd, risk, matched_rule, decision, detail, transcript_path) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    session_id,
                    source,
                    tool_name,
                    cwd,
                    risk,
                    matched_rule,
                    decision,
                    json.dumps(detail, ensure_ascii=False, default=str),
                    transcript_path,
                ),
            )
    finally:
        conn.close()


def get_latest_session_id():
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT session_id FROM events "
            "WHERE session_id IS NOT NULL AND session_id != '' "
            "ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def get_transcript_path(session_id):
    """返回某个 session 最近一次记录到的 transcript jsonl 路径（同一个 session 应该都是同一个文件）。"""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT transcript_path FROM events "
            "WHERE session_id = ? AND transcript_path IS NOT NULL AND transcript_path != '' "
            "ORDER BY id DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def fetch_recent(limit=50, since_id=0):
    """按 id 升序返回 id > since_id 的事件，供 `tail` 之类的增量轮询使用。"""
    conn = _connect()
    try:
        cur = conn.execute(
            "SELECT id, ts, source, tool_name, risk, matched_rule, decision, detail, cwd "
            "FROM events WHERE id > ? ORDER BY id ASC LIMIT ?",
            (since_id, limit),
        )
        return cur.fetchall()
    finally:
        conn.close()


def fetch_last(limit=200):
    """按 id 降序返回最近 N 条事件（最新的在前），供交叉验证等只关心"最近发生了什么"的场景使用。"""
    conn = _connect()
    try:
        cur = conn.execute(
            "SELECT id, ts, source, tool_name, risk, matched_rule, decision, detail, cwd "
            "FROM events ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        return cur.fetchall()
    finally:
        conn.close()
