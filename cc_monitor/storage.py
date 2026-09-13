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

-- action=confirm 的操作既可以在触发它的那个终端里直接按 y/N，也可以在 Web UI 的
-- "待批准"页面点按钮——两条路谁先写进这张表、谁的结果就算数（status 从 'pending'
-- 变成别的值之后，另一条路的 UPDATE 因为 WHERE status='pending' 不成立而不会生效）。
CREATE TABLE IF NOT EXISTS pending_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    session_id TEXT,
    tool_name TEXT,
    cwd TEXT,
    matched_rule TEXT,
    matched_value TEXT,
    risk TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    resolved_at TEXT,
    resolved_via TEXT
);

-- "一直允许"是按 session 生效的，不是改全局规则——同一个 session 里这条规则
-- 以后不用再问，别的 session（哪怕跑一模一样的命令）还是照常问。expires_at 为空
-- 表示真的"一直"；有值的话是"批准，N 分钟内不再询问"这种限时版本，到点之后
-- is_session_always_allowed() 就不再认它，恢复正常询问。
CREATE TABLE IF NOT EXISTS session_always_allow (
    session_id TEXT NOT NULL,
    matched_rule TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    PRIMARY KEY (session_id, matched_rule)
);
"""


def _connect():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=5)
    conn.execute("PRAGMA journal_mode=WAL;")
    # SCHEMA 现在是好几条 CREATE TABLE 拼在一起的——sqlite3.Connection.execute()
    # 一次只能跑一条语句，多条得用 executescript()。
    conn.executescript(SCHEMA)
    try:
        conn.execute("ALTER TABLE events ADD COLUMN transcript_path TEXT")
    except sqlite3.OperationalError:
        pass  # 列已经存在（老数据库升级过一次之后）
    try:
        conn.execute("ALTER TABLE session_always_allow ADD COLUMN expires_at TEXT")
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


def create_pending_approval(session_id, tool_name, cwd, matched_rule, matched_value, risk):
    conn = _connect()
    try:
        with conn:
            cur = conn.execute(
                "INSERT INTO pending_approvals "
                "(ts, session_id, tool_name, cwd, matched_rule, matched_value, risk, status) "
                "VALUES (?,?,?,?,?,?,?,'pending')",
                (time.strftime("%Y-%m-%dT%H:%M:%S%z"), session_id, tool_name, cwd, matched_rule, matched_value, risk),
            )
            return cur.lastrowid
    finally:
        conn.close()


def poll_approval_status(approval_id):
    conn = _connect()
    try:
        row = conn.execute("SELECT status FROM pending_approvals WHERE id = ?", (approval_id,)).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def resolve_approval(approval_id, status, via):
    """把一条待批准记录标成 status（allowed/denied/always_allowed/expired）。

    WHERE status='pending' 是关键：tty 和 Web UI 两条路可能同时想resolve 同一条，
    谁的 UPDATE 先落地、changes 就是 1，另一条因为这时候 status 已经不是 pending
    了，UPDATE 不会生效——不用额外加锁，SQLite 本身的事务隔离就够了。
    """
    conn = _connect()
    try:
        with conn:
            cur = conn.execute(
                "UPDATE pending_approvals SET status = ?, resolved_at = ?, resolved_via = ? "
                "WHERE id = ? AND status = 'pending'",
                (status, time.strftime("%Y-%m-%dT%H:%M:%S%z"), via, approval_id),
            )
            return cur.rowcount > 0
    finally:
        conn.close()


def is_session_always_allowed(session_id, matched_rule):
    if not session_id or not matched_rule:
        return False
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT expires_at FROM session_always_allow WHERE session_id = ? AND matched_rule = ?",
            (session_id, matched_rule),
        ).fetchone()
        if row is None:
            return False
        expires_at = row[0]
        # expires_at 为空是真的"一直允许"；有值就是限时版本，字符串比较当前时间——
        # 跟 events 表其它时间戳一样都用同一个 strftime 格式/时区，直接比就行。
        return expires_at is None or expires_at > time.strftime("%Y-%m-%dT%H:%M:%S%z")
    finally:
        conn.close()


def add_session_always_allow(session_id, matched_rule, expires_at=None):
    conn = _connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO session_always_allow (session_id, matched_rule, created_at, expires_at) VALUES (?,?,?,?) "
                "ON CONFLICT(session_id, matched_rule) DO UPDATE SET created_at = excluded.created_at, expires_at = excluded.expires_at",
                (session_id, matched_rule, time.strftime("%Y-%m-%dT%H:%M:%S%z"), expires_at),
            )
    finally:
        conn.close()
