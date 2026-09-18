"""系统层探针文件级观测 / 监听端口 / 显式绑定的回归测试（不需要 root、不跑 bpftrace：
直接喂探针的文本事件行给 probe.py 的解析函数，落库的调用用假的 storage.log_event 截住）。

直接跑：python3 -m unittest tests/test_probe_files.py
"""
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

_TMP = tempfile.mkdtemp(prefix="cc-monitor-test-")
os.environ["CC_MONITOR_HOME"] = _TMP
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _REPO)

from cc_monitor import probe, procscan, run, storage  # noqa: E402


class _Capture(object):
    def __init__(self):
        self.events = []

    def __call__(self, **kw):
        self.events.append(kw)


class TestPathResolution(unittest.TestCase):
    def setUp(self):
        probe._cwd_cache.clear()
        probe._dirfds.clear()

    def test_chdir_fork_inherit(self):
        probe._cwd_cache["10"] = "/work"
        probe._handle_fork_line(["FORK", "10", "11"])
        self.assertEqual(probe._resolve_path("11", "a.txt"), "/work/a.txt")
        probe._handle_chdir_line(["CHDIR", "11", "0", "sh", "10", "sub"])
        self.assertEqual(probe._resolve_path("11", "b.txt"), "/work/sub/b.txt")
        self.assertEqual(probe._resolve_path("11", "/abs/c"), "/abs/c")

    def test_opendir_dup_and_dirfd_relative(self):
        probe._cwd_cache["20"] = "/proj"
        probe._handle_opendir_line(["OPENDIR", "20", "0", "rm", "20", "3", ".st", "-100"])
        self.assertEqual(probe._dirfds[("20", "3")], "/proj/.st")
        probe._handle_dup_line(["DUP", "20", "0", "rm", "20", "3", "4"])
        probe._handle_opendir_line(["OPENDIR", "20", "0", "rm", "20", "3", "deep", "4"])  # 相对 fd 4
        self.assertEqual(probe._dirfds[("20", "3")], "/proj/.st/deep")
        self.assertEqual(probe._resolve_path("20", "f", 3), "/proj/.st/deep/f")
        self.assertEqual(probe._resolve_path("20", "deep", 4), "/proj/.st/deep")
        probe._handle_fchdir_line(["FCHDIR", "20", "0", "rm", "20", "4"])
        self.assertEqual(probe._resolve_path("20", "x"), "/proj/.st/x")

    def test_unknown_dirfd_falls_back_to_cwd(self):
        probe._cwd_cache["30"] = "/home/u/p"
        with mock.patch("os.readlink", side_effect=OSError):
            self.assertEqual(probe._resolve_path("30", "f", 7), "/home/u/p/f")


class TestFileFiltering(unittest.TestCase):
    def test_ignored_paths(self):
        for p in ("/proj/.git/index.lock", "/proj/node_modules/x/y.js", "/root/.claude/projects/a.jsonl",
                  "/tmp/x", "/proj/a.pyc", "/proj/__pycache__/m.cpython.pyc", "/usr/lib/x", "/root/.cache/pip/x"):
            self.assertTrue(probe._file_ignored(p), p)
        for p in ("/proj/src/a.py", "/root/.ssh/authorized_keys", "/etc/passwd", "/home/u/.bashrc"):
            self.assertFalse(probe._file_ignored(p), p)

    def test_agent_state_dirs(self):
        self.assertTrue(probe._is_agent_state_path("/root/.claude/settings.json", "claude-code"))
        self.assertTrue(probe._is_agent_state_path("/root/.claude.json", "claude-code"))
        self.assertTrue(probe._is_agent_state_path("/root/.claude.json.tmp.87740.1723e23e26bb", "claude-code"))
        self.assertTrue(probe._file_ignored("/root/.claude.json.tmp.87740.1723e23e26bb"))
        self.assertFalse(probe._file_ignored("/root/.claude-other/x"))
        self.assertFalse(probe._is_agent_state_path("/root/.ssh/id_rsa", "claude-code"))


class TestFileEvents(unittest.TestCase):
    def setUp(self):
        probe._cwd_cache.clear()
        probe._dirfds.clear()
        probe.FILES.windows.clear()
        probe.FILES.storm.clear()
        probe.ROOTS.set(100, "claude-code")
        probe._cwd_cache["100"] = "/proj"
        probe._cwd_cache["101"] = "/proj"
        self.cap = _Capture()
        self.patches = [
            mock.patch.object(storage, "log_event", self.cap),
            mock.patch.object(storage, "fetch_recent_file_writes", return_value=[]),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def _file(self, pid, op, path, path2="", dirfd="-100", comm="sh"):
        probe._handle_file_line(["FILE", str(pid), "0", comm, "100", op, "0", path, path2, dirfd])

    def test_child_write_to_sensitive_path_hits_rule_but_no_bypass(self):
        self._file(101, "write", "/root/.ssh/authorized_keys", comm="touch")
        ev = self.cap.events[-1]
        self.assertEqual(ev["source"], "os_file")
        self.assertEqual(ev["matched_rule"], "sensitive_file_write")
        self.assertEqual(ev["risk"], "high")
        self.assertEqual(ev["agent"], "claude-code")
        self.assertFalse(ev["detail"]["by_agent_process"])
        self.assertIsNone(ev["detail"]["hook_matched"])

    def test_agent_process_write_without_hook_record_is_bypass(self):
        self._file(100, "write", "src/a.py", comm="claude")
        ev = self.cap.events[-1]
        self.assertEqual(ev["detail"]["path"], "/proj/src/a.py")
        self.assertTrue(ev["detail"]["by_agent_process"])
        self.assertEqual(ev["matched_rule"], "hook_bypass_suspected")
        self.assertEqual(ev["risk"], "high")

    def test_agent_process_write_with_hook_record_is_matched(self):
        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with mock.patch.object(storage, "fetch_recent_file_writes", return_value=[(now, "claude-code", "/proj/src/b.py")]):
            self._file(100, "write", "/proj/src/b.py", comm="claude")
        ev = self.cap.events[-1]
        self.assertTrue(ev["detail"]["hook_matched"])
        self.assertIsNone(ev["matched_rule"])

    def test_agent_state_write_is_not_bypass(self):
        self._file(100, "write", "/root/.claude/todos/x.json", comm="claude")
        self.assertEqual(self.cap.events, [])  # 状态目录在排除表里，根本不落库

    def test_rename_reports_target_and_aggregation_counts(self):
        self._file(101, "rename", "/proj/a", "/proj/b", comm="mv")
        self.assertEqual(self.cap.events[-1]["detail"]["path2"], "/proj/b")
        n = len(self.cap.events)
        for _ in range(4):
            self._file(101, "write", "/proj/log.txt")
        self.assertEqual(len(self.cap.events), n + 1, "60 秒窗口内同一路径只落库一次")
        probe.FILES.flush_expired(time.time() + probe.FILE_AGG_WINDOW_SEC + 1)
        agg = self.cap.events[-1]
        self.assertTrue(agg["detail"]["aggregated"])
        self.assertEqual(agg["detail"]["count"], 4)

    def test_storm_breaker(self):
        # 熔断按"同一秒"计数，把时钟钉住，免得循环跨秒让计数器重置（真机上跨秒重置是对的）
        with mock.patch.object(probe.time, "time", return_value=1_800_000_000.5):
            for i in range(probe.FILE_STORM_PER_SEC + 50):
                self._file(101, "write", "/proj/out/f{}.txt".format(i))
        self.assertEqual(len(self.cap.events), probe.FILE_STORM_PER_SEC)

    def test_listen_exposed_vs_local(self):
        probe._handle_bind_line(["BIND", "101", "0", "python3", "100", "5", "0.0.0.0", "8080"])
        probe._handle_listen_line(["LISTEN", "101", "0", "python3", "100", "5"])
        ev = self.cap.events[-1]
        self.assertEqual((ev["source"], ev["risk"], ev["matched_rule"]), ("os_listen", "medium", "listen_exposed"))
        self.assertEqual(ev["detail"]["port"], "8080")
        probe._handle_bind_line(["BIND", "101", "0", "python3", "100", "6", "127.0.0.1", "9000"])
        probe._handle_listen_line(["LISTEN", "101", "0", "python3", "100", "6"])
        self.assertEqual((self.cap.events[-1]["risk"], self.cap.events[-1]["matched_rule"]), ("low", None))
        n = len(self.cap.events)
        probe._handle_listen_line(["LISTEN", "101", "0", "python3", "100", "99"])  # 没见过 bind：不记
        self.assertEqual(len(self.cap.events), n)


class TestTemplateHasFileProbes(unittest.TestCase):
    def test_probes_present(self):
        bt = probe.render_script(seed={})
        for needle in ("sys_enter_openat", "sys_exit_unlinkat", "sys_exit_renameat2", "sys_exit_mkdirat",
                       "sys_enter_bind", "sys_enter_listen", "sys_enter_fchdir", "sys_exit_fcntl", "sys_enter_rmdir",
                       "OPENDIR", "f_inode->i_mode"):
            self.assertIn(needle, bt, needle)
        self.assertNotIn("__CC_", bt)


class TestRunBinding(unittest.TestCase):
    def test_registration_roundtrip_and_cleanup(self):
        run.register(os.getpid(), "aider", "sess", ["aider"], "/usr/bin/python3")
        self.assertEqual(run.load_registrations().get(os.getpid()), "aider")
        run.register(999999, "x", "s", ["x"], "/x")  # 不存在的 pid：下次读取时被清理
        regs = run.load_registrations()
        self.assertNotIn(999999, regs)
        self.assertFalse((run.RUN_DIR / "999999.json").exists())

    def test_registered_pid_is_root_even_when_nested(self):
        procs = {
            1: {"ppid": 0, "comm": "init", "argv": "", "exe": ""},
            20: {"ppid": 1, "comm": "claude", "argv": "claude", "exe": "/x/claude"},
            21: {"ppid": 20, "comm": "python3", "argv": "python3 my_agent.py", "exe": "/usr/bin/python3"},
            22: {"ppid": 21, "comm": "bash", "argv": "bash -c ls", "exe": ""},
        }
        roots = procscan.find_roots(procs, registrations={21: "generic"})
        self.assertEqual(roots, {20: "claude-code", 21: "generic"})
        self.assertTrue(probe._file_ignored("/root/.local/bin/.update_test123"))  # agy 自更新探测文件
        seed = procscan.seed_map(procs, registrations={21: "generic"})
        self.assertEqual(seed[22], (21, "generic"))

    def test_resolve_binary_follows_shebang(self):
        d = tempfile.mkdtemp()
        script = os.path.join(d, "tool")
        with open(script, "w") as f:
            f.write("#!/usr/bin/env python3\nprint(1)\n")
        os.chmod(script, 0o755)
        self.assertTrue(run.resolve_binary(script).endswith("python3") or "python" in run.resolve_binary(script))


if __name__ == "__main__":
    unittest.main()
