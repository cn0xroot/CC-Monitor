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
-- kind='confirm' 是原来那种"是否允许执行"的确认框——网页/终端两条路谁先给结果
-- 算谁的。kind='notify' 是后来加的："Claude Code 在问用户一个澄清性问题"这类
-- 压根没有 allow/deny 语义的交互（AskUserQuestion 之类）：hook 只是把它记下来
-- 给网页看"现在有个问题在等你"，从不阻塞、从不弹确认框，答案只能在触发它的那个
-- 终端里给（我们没有、也不该去帮用户瞎选一个选项）——对应的 PostToolUse 事件一来
-- 就会把这条记录标成"已回答"，自动从"待处理"里消失。
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
    resolved_via TEXT,
    kind TEXT NOT NULL DEFAULT 'confirm',
    resolved_value TEXT
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

-- 按 (ip, port) 聚合的流量统计——来自系统层探针新增的 tcp_sendmsg/tcp_cleanup_rbuf
-- 内核探点，每 2 秒汇总一次字节数累加进来。跟 events 表里 source='os_net' 的单条
-- CONNECT 记录是互补关系：那边是"什么时候连过这个地址"的时间线，这张表是"总共
-- 传了多少字节"的累计值，只有装了 bpftrace、探针在跑的时候才会有数据。
-- 键值表，目前只有一个键：rules_fingerprint——上一次用哪份规则表把历史事件重判过
-- （见 rematch.py）。hook 每次调用拿当前规则指纹跟它比，不一样就说明规则改过、
-- 历史事件的 matched_rule 已经过时，后台起一个 rematch 进程重判。
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS network_traffic (
    ip TEXT NOT NULL,
    port INTEGER NOT NULL,
    host TEXT,
    tx_bytes INTEGER NOT NULL DEFAULT 0,
    rx_bytes INTEGER NOT NULL DEFAULT 0,
    connect_count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (ip, port)
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
    try:
        conn.execute("ALTER TABLE pending_approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'confirm'")
    except sqlite3.OperationalError:
        pass  # 列已经存在（老数据库升级过一次之后）
    try:
        conn.execute("ALTER TABLE pending_approvals ADD COLUMN resolved_value TEXT")
    except sqlite3.OperationalError:
        pass  # 列已经存在（老数据库升级过一次之后）
    # 多 agent 支持：事件/审批记录都带上"来自哪家 agent"。带常量默认值的 ADD COLUMN 会让
    # 老行直接得到 'claude-code'——升级前的数据库里只可能有 Claude Code 的记录。
    # native_tool 记 agent 自己的工具名（tool_name 列存的是映射后的 Claude Code 词汇）。
    for stmt in (
        "ALTER TABLE events ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude-code'",
        "ALTER TABLE events ADD COLUMN native_tool TEXT",
        "ALTER TABLE pending_approvals ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude-code'",
    ):
        try:
            conn.execute(stmt)
        except sqlite3.OperationalError:
            pass  # 列已经存在
    return conn


DEFAULT_AGENT = "claude-code"


def log_event(session_id, source, tool_name, detail, cwd, risk, matched_rule, decision, transcript_path=None,
              agent=DEFAULT_AGENT, native_tool=None):
    conn = _connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO events "
                "(ts, session_id, source, tool_name, cwd, risk, matched_rule, decision, detail, transcript_path, agent, native_tool) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
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
                    agent or DEFAULT_AGENT,
                    native_tool if native_tool and native_tool != tool_name else None,
                ),
            )
    finally:
        conn.close()


def iter_hook_pre_events():
    """按 id 升序把所有 PreToolUse 事件吐出来：(id, tool_name, risk, matched_rule, detail, cwd)。
    给 rematch 用——规则改了以后用当前规则把历史事件重新判一遍（cwd 是 workdir 类
    规则重判时要用的）。"""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, tool_name, risk, matched_rule, detail, cwd FROM events WHERE source = 'hook_pre' ORDER BY id"
        ).fetchall()
    finally:
        conn.close()
    return rows


def update_event_matches(updates):
    """批量改 (risk, matched_rule)：updates 是 [(risk, matched_rule, event_id), ...]。
    只动这两列——decision 是当时真实发生的放行/拦截结果，重判不改写历史。"""
    if not updates:
        return
    conn = _connect()
    try:
        with conn:
            conn.executemany("UPDATE events SET risk = ?, matched_rule = ? WHERE id = ?", updates)
    finally:
        conn.close()


def get_meta(key):
    conn = _connect()
    try:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def claim_meta(key, value):
    """把 meta[key] 设成 value；只有当它原来不是这个值时才算"认领成功"（返回 True）。
    多个 hook 进程几乎同时发现规则变了，靠这条 upsert 的原子性保证只有一个去起
    后台重判，其它的看到 rowcount=0 就当没事。"""
    conn = _connect()
    try:
        with conn:
            cur = conn.execute(
                "INSERT INTO meta (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value IS NOT excluded.value",
                (key, value),
            )
            return cur.rowcount > 0
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


def count_by_agent():
    """[(agent, n)]，事件数降序。"""
    conn = _connect()
    try:
        return conn.execute("SELECT agent, COUNT(*) FROM events GROUP BY agent ORDER BY 2 DESC").fetchall()
    finally:
        conn.close()


def fetch_recent_shell_commands(agent=None, limit=300):
    """最近的 hook_pre Bash 记录 [(ts_epoch_str, agent, command)]，探针的绕过交叉验证用。
    传 agent 只看那一家的（多 agent 并行时别拿 A 的 hook 记录去解释 B 的进程）。"""
    conn = _connect()
    try:
        sql = ("SELECT ts, agent, detail FROM events WHERE source = 'hook_pre' AND tool_name = 'Bash'")
        params = []
        if agent:
            sql += " AND agent = ?"
            params.append(agent)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        out = []
        for ts, ag, detail_raw in conn.execute(sql, params).fetchall():
            try:
                cmd = (json.loads(detail_raw).get("command") or "").strip()
            except (ValueError, AttributeError):
                continue
            out.append((ts, ag, cmd))
        return out
    finally:
        conn.close()


def fetch_by_rule_prefix(prefix, limit=200):
    """按 id 降序返回 matched_rule 以 prefix 开头的 PreToolUse 事件（最新的在前），
    字段顺序跟 fetch_recent 一致。`CC-Monitor workdir` 用它列跨工作目录的操作。"""
    conn = _connect()
    try:
        cur = conn.execute(
            "SELECT id, ts, source, tool_name, risk, matched_rule, decision, detail, cwd "
            "FROM events WHERE source = 'hook_pre' AND matched_rule LIKE ? ESCAPE '\\' "
            "ORDER BY id DESC LIMIT ?",
            (prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%", limit),
        )
        return cur.fetchall()
    finally:
        conn.close()


def create_pending_approval(session_id, tool_name, cwd, matched_rule, matched_value, risk, kind="confirm", agent=DEFAULT_AGENT):
    conn = _connect()
    try:
        with conn:
            cur = conn.execute(
                "INSERT INTO pending_approvals "
                "(ts, session_id, tool_name, cwd, matched_rule, matched_value, risk, status, kind, agent) "
                "VALUES (?,?,?,?,?,?,?,'pending',?,?)",
                (time.strftime("%Y-%m-%dT%H:%M:%S%z"), session_id, tool_name, cwd, matched_rule, matched_value, risk, kind, agent or DEFAULT_AGENT),
            )
            return cur.lastrowid
    finally:
        conn.close()


def resolve_pending_notify(session_id, tool_name, tool_response=None):
    """action='notify' 那类记录（比如 AskUserQuestion）没有 tty/网页两条路可 resolve——
    唯一能"结束等待"的信号就是对应的 PostToolUse 事件真的来了（说明用户已经在触发它
    的那个终端里选完了）。同一个 session 同一个工具短时间内理论上可能连续问好几次，
    只挑最新的那条'pending'状态的记录标掉，不会把更早、可能是别的原因还没处理完的
    记录也捎带手误标了。

    tool_response（PostToolUse 自带的、这个工具调用真正的返回值）对 AskUserQuestion
    来说带着 `answers`：{问题文本: 用户实际选的答案} ——原样存成 JSON 到 resolved_value，
    这样"审批历史记录"里不止看得到当时问了什么（matched_value），也看得到用户到底
    答了什么。其它工具/tool_response 里没有这个字段的话就留空，不是错误。
    """
    resolved_value = None
    if isinstance(tool_response, dict):
        answers = tool_response.get("answers")
        if answers:
            resolved_value = json.dumps(answers, ensure_ascii=False)
    conn = _connect()
    try:
        with conn:
            cur = conn.execute(
                "UPDATE pending_approvals SET status = 'answered', resolved_at = ?, resolved_via = 'post_tool_use', resolved_value = ? "
                "WHERE id = (SELECT id FROM pending_approvals "
                "            WHERE session_id = ? AND tool_name = ? AND kind = 'notify' AND status = 'pending' "
                "            ORDER BY id DESC LIMIT 1)",
                (time.strftime("%Y-%m-%dT%H:%M:%S%z"), resolved_value, session_id, tool_name),
            )
            return cur.rowcount > 0
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


def record_network_connect(ip, port, host):
    """CONNECT 事件（探针每次观测到新连接都调一次）：新地址就插入一行，见过的地址
    就把 connect_count 加一、host/last_seen 更新一下（host 可能这次才反解析出来，
    之前是 None 的话趁机补上）。
    """
    conn = _connect()
    try:
        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with conn:
            conn.execute(
                "INSERT INTO network_traffic (ip, port, host, connect_count, first_seen, last_seen) "
                "VALUES (?,?,?,1,?,?) "
                "ON CONFLICT(ip, port) DO UPDATE SET "
                "host = COALESCE(excluded.host, network_traffic.host), "
                "connect_count = network_traffic.connect_count + 1, "
                "last_seen = excluded.last_seen",
                (ip, port, host, now, now),
            )
    finally:
        conn.close()


def record_network_bytes(ip, port, tx_bytes=0, rx_bytes=0):
    """字节数统计（探针每 2 秒汇总一次调用）：累加到已有的 tx/rx 总数上，不是覆盖。
    可能是这个 (ip, port) 第一次在字节层面被观测到（比如 CONNECT 那行因为某些原因
    没抓到，或者是同一个长连接反复收发），所以这里也用 INSERT OR UPDATE，不假设
    行已经存在。
    """
    conn = _connect()
    try:
        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with conn:
            conn.execute(
                "INSERT INTO network_traffic (ip, port, tx_bytes, rx_bytes, first_seen, last_seen) "
                "VALUES (?,?,?,?,?,?) "
                "ON CONFLICT(ip, port) DO UPDATE SET "
                "tx_bytes = network_traffic.tx_bytes + excluded.tx_bytes, "
                "rx_bytes = network_traffic.rx_bytes + excluded.rx_bytes, "
                "last_seen = excluded.last_seen",
                (ip, port, tx_bytes, rx_bytes, now, now),
            )
    finally:
        conn.close()


def list_network_traffic(limit=500):
    conn = _connect()
    try:
        cur = conn.execute(
            "SELECT ip, port, host, tx_bytes, rx_bytes, connect_count, first_seen, last_seen "
            "FROM network_traffic ORDER BY (tx_bytes + rx_bytes) DESC LIMIT ?",
            (limit,),
        )
        return cur.fetchall()
    finally:
        conn.close()
