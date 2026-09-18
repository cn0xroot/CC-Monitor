"""介入级别开关的回归测试：permissive 别名、落盘值的向后兼容、以及 hook 在观察模式下
"照常判定和记录、但绝不拦截"的行为。

直接跑：python3 -m unittest tests/test_audit_state.py
用隔离的 CC_MONITOR_HOME，不碰 ~/.cc-monitor 里用户自己的状态和数据库。
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

_TMP = tempfile.mkdtemp(prefix="cc-monitor-test-")
os.environ["CC_MONITOR_HOME"] = _TMP
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _REPO)

from cc_monitor import audit_state  # noqa: E402

# pytest 会先把所有测试模块都 import 一遍，cc_monitor.audit_state 的 CONFIG_DIR 是第一个
# import 它的测试模块的 _TMP——不一定是这个文件的。子进程必须用进程内模块实际在用的那个
# 目录，否则进程内 set_state() 写的状态子进程看不到（默认 running → confirm 规则会在 tty
# 上等 90 秒才超时）。
_TMP = str(audit_state.CONFIG_DIR)


class TestStateAliases(unittest.TestCase):
    def test_canonical_values_pass_through(self):
        for s in ("running", "paused", "stopped"):
            self.assertEqual(audit_state.normalize_state(s), s)

    def test_permissive_is_an_alias_of_paused(self):
        # permissive 是这一档对外主推的名字，observe / log-only 是同义写法。
        for alias in ("permissive", "observe", "log-only", "log_only"):
            self.assertEqual(audit_state.normalize_state(alias), "paused")

    def test_enforcing_and_off_aliases(self):
        for alias in ("enforcing", "enforce"):
            self.assertEqual(audit_state.normalize_state(alias), "running")
        for alias in ("disabled", "off"):
            self.assertEqual(audit_state.normalize_state(alias), "stopped")

    def test_case_and_whitespace_insensitive(self):
        self.assertEqual(audit_state.normalize_state("  PERMISSIVE "), "paused")

    def test_unknown_is_rejected(self):
        self.assertIsNone(audit_state.normalize_state("bogus"))
        self.assertIsNone(audit_state.normalize_state(None))
        with self.assertRaises(ValueError):
            audit_state.set_state("bogus")

    def test_disk_format_stays_backward_compatible(self):
        """写 permissive，磁盘上必须还是 paused——老版本 CC-Monitor 和任何直接读这个
        文件的脚本都按 running/paused/stopped 三个值解析，改名不能把它们弄坏。"""
        audit_state.set_state("permissive")
        on_disk = json.loads(open(audit_state.STATE_FILE, encoding="utf-8").read())
        self.assertEqual(on_disk["state"], "paused")
        self.assertEqual(audit_state.get_state(), "paused")


def run_hook(payload):
    """跑一次 PreToolUse hook，返回 (exit_code, stderr)。"""
    proc = subprocess.run(
        [sys.executable, "-m", "cc_monitor.hook", "pre"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=_REPO,
        env={**os.environ, "CC_MONITOR_HOME": _TMP},
    )
    return proc.returncode, proc.stderr


def open_test_db():
    """连到本测试自己那份 events.db。

    不能用 cc_monitor.storage 里的连接助手：它的 DB_PATH 是模块级常量，在 storage 首次
    被 import 时就按当时的 CC_MONITOR_HOME 定死了。同一次 pytest 里 tests/ 下别的文件
    也各自设了自己的 CC_MONITOR_HOME，谁先 import 谁说了算——依赖这个顺序的话，单独跑
    能过、全量跑就会读到别人的库。这里按 _TMP 显式拼路径，跟 import 顺序无关。
    """
    import sqlite3

    return sqlite3.connect(os.path.join(_TMP, "events.db"), timeout=5)


DANGEROUS = {
    "tool_name": "Bash",
    "tool_input": {"command": "rm -rf /"},
    "session_id": "test-audit-state",
    "cwd": "/tmp",
}


class TestPermissiveNeverBlocks(unittest.TestCase):
    def tearDown(self):
        audit_state.set_state("running")

    def test_enforcing_blocks(self):
        audit_state.set_state("running")
        code, err = run_hook(DANGEROUS)
        self.assertEqual(code, 2, "拦截中这一档必须真的拦下来")
        self.assertIn("被拦截", err)

    def test_permissive_allows_but_still_records(self):
        audit_state.set_state("permissive")
        code, err = run_hook(DANGEROUS)
        self.assertEqual(code, 0, "观察模式下绝不能拦截")
        self.assertNotIn("被拦截", err)

        # 关键点：放行了，但 risk / matched_rule 必须照常记下来，
        # 否则这一档就退化成了"关闭"。
        conn = open_test_db()
        row = conn.execute(
            "SELECT risk, matched_rule, decision FROM events "
            "WHERE session_id=? AND source='hook_pre' ORDER BY id DESC LIMIT 1",
            (DANGEROUS["session_id"],),
        ).fetchone()
        conn.close()
        self.assertIsNotNone(row, "观察模式必须留下审计记录")
        self.assertEqual(row[0], "high")
        self.assertEqual(row[1], "dangerous_delete")
        self.assertEqual(row[2], "allowed")

    def test_permissive_creates_no_pending_approvals(self):
        """观察模式的承诺是"不弹确认框"——审批台里不能冒出待处理条目。"""
        conn = open_test_db()
        conn.execute("DELETE FROM pending_approvals")
        conn.commit()
        conn.close()

        audit_state.set_state("permissive")
        # confirm 档的规则：网络搜索。正常模式下会问，观察模式下必须直接放行。
        code, _ = run_hook({
            "tool_name": "WebSearch",
            "tool_input": {"query": "anything"},
            "session_id": "test-audit-state",
            "cwd": "/tmp",
        })
        self.assertEqual(code, 0)

        conn = open_test_db()
        n = conn.execute("SELECT count(*) FROM pending_approvals").fetchone()[0]
        conn.close()
        self.assertEqual(n, 0, "观察模式下不能产生任何待确认条目")


if __name__ == "__main__":
    unittest.main()
