"""default_rules.json 的回归测试：哪些命令/路径必须命中哪条规则、哪些不能误报。

直接跑：python3 -m unittest tests/test_rules.py
用隔离的 CC_MONITOR_HOME，不碰 ~/.cc-monitor 里用户自己的 rules.json。
"""
import os
import sys
import tempfile
import unittest

_TMP = tempfile.mkdtemp(prefix="cc-monitor-test-")
os.environ["CC_MONITOR_HOME"] = _TMP
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cc_monitor import policy  # noqa: E402


def rule_id(tool, **tool_input):
    rule, _ = policy.evaluate(tool, tool_input)
    return rule["id"] if rule else None


class SystemPackageInstallTest(unittest.TestCase):
    HITS = [
        "sudo port install wget",
        "port install wget",
        "sudo port -N install python312",
        "sudo port -v -N install git +universal",
        "sudo port -D /opt/local install foo",
        "sudo port --debug install foo",
        "sudo /opt/local/bin/port install wget",
        "sudo port selfupdate && sudo port upgrade outdated",
        "sudo port sync",
        "sudo -H port install git",
        "port -f uninstall foo",
        "echo wget | xargs sudo port install",
        "osascript -e 'do shell script \"port install wget\" with administrator privileges'",
        "brew install wget",
        "sudo apt-get install -y curl",
        "sudo pacman -Syu",
    ]
    MISSES = [
        "port installed",
        "port search wget",
        "port info wget",
        "which port",
        "lsof -i :8080 | grep port",
        "python3 report.py --port 8080",
    ]

    def test_hits(self):
        for cmd in self.HITS:
            self.assertEqual(rule_id("Bash", command=cmd), "system_package_install", cmd)

    def test_misses(self):
        for cmd in self.MISSES:
            self.assertNotEqual(rule_id("Bash", command=cmd), "system_package_install", cmd)


class SegmentMatchTest(unittest.TestCase):
    """match="segment" 只看子命令开头：提到安装命令字样的字符串/heredoc 不能误报，
    真正在执行的（包括藏在 bash -c / xargs / 环境变量前缀 / 子 shell 括号里的）要命中。"""

    INSTALL_RULES = ("system_package_install", "package_install_other", "npm_global_install", "npm_local_install",
                     "sudo_usage", "sudo_pip_install", "pip_install_no_venv", "su_pkexec_privilege_escalation")
    FALSE_POSITIVES = [
        'grep -n "port install" cc_monitor/default_rules.json',
        'grep -rn "apt-get install" docs/ | head',
        'echo "brew install wget"',
        'echo "run: sudo apt install curl" >> README.md',
        "python3 - <<'EOF'\nprint(\"sudo apt install foo\")\nx = \"a && sudo rm\"\nEOF",
        'git commit -m "docs: mention brew install step"',
        "sqlite3 db \"SELECT * FROM events WHERE detail LIKE '%port install%'\"",
        "cat <<EOF > notes.txt\nnpm install -g foo\nEOF",
        'grep "npm install" package.json',
        "git commit -m 'sudo pip install docs'",
        "echo 'sudo' | cat",
        "ls | grep su",
    ]
    TRUE_POSITIVES = {
        "sudo apt install -y curl": "system_package_install",
        "sudo apt-get update && sudo apt-get install -y curl": "system_package_install",
        "brew install wget": "system_package_install",
        "HOMEBREW_NO_AUTO_UPDATE=1 brew install wget": "system_package_install",
        "(cd /tmp && brew install wget)": "system_package_install",
        "bash -c 'sudo apt-get install -y curl'": "system_package_install",
        'sudo sh -c "apt-get install -y curl"': "system_package_install",
        "echo wget | xargs sudo port install": "system_package_install",
        "env DEBIAN_FRONTEND=noninteractive apt-get install -y curl": "system_package_install",
        "/usr/bin/apt-get install -y curl": "system_package_install",
        "time sudo port -N install python312": "system_package_install",
        "sudo -H port install git": "system_package_install",
        "npm install -g cowsay": "npm_global_install",
        "cd proj && npm install": "npm_local_install",
        "cargo install ripgrep": "package_install_other",
        "gem install bundler": "package_install_other",
        "cd /tmp; sudo make install": "sudo_usage",
        "sudo pip install x": "sudo_pip_install",
        "sudo python3 -m pip install x": "sudo_pip_install",
        "pip install uv": "pip_install_no_venv",
        "source .venv/bin/activate && pip install x": "pip_install_venv_context",
        "su -": "su_pkexec_privilege_escalation",
        "pkexec ls": "su_pkexec_privilege_escalation",
    }

    def test_false_positives(self):
        for cmd in self.FALSE_POSITIVES:
            self.assertNotIn(rule_id("Bash", command=cmd), self.INSTALL_RULES, cmd)

    def test_true_positives(self):
        for cmd, expected in self.TRUE_POSITIVES.items():
            self.assertEqual(rule_id("Bash", command=cmd), expected, cmd)

    def test_matched_value_is_the_segment(self):
        rule, value = policy.evaluate("Bash", {"command": "cd /tmp && sudo apt-get install -y curl | tail -1"})
        self.assertEqual(rule["id"], "system_package_install")
        self.assertEqual(value.strip(), "apt-get install -y curl")

    def test_split_respects_quotes_and_heredocs(self):
        segs = policy.split_shell_segments("echo 'a; b' && cat <<EOF\nx | y\nEOF\n; ls")
        self.assertEqual([s.strip() for s in segs if s.strip()], ["echo 'a; b'", "cat <<EOF\nx | y\nEOF", "ls"])


class RematchTest(unittest.TestCase):
    """规则改了之后，历史事件的 matched_rule 要能按新规则重算；decision 不动。"""

    def test_rematch_updates_stale_matches(self):
        from cc_monitor import rematch, storage
        storage.log_event("s1", "hook_pre", "Bash", {"command": 'grep "port install" f'}, "/tmp", "medium",
                          "system_package_install", "allowed")
        storage.log_event("s1", "hook_pre", "Bash", {"command": "cat ~/.zsh_history"}, "/tmp", "low", None, "allowed")
        storage.log_event("s1", "hook_pre", "Bash", {"command": "brew install wget"}, "/tmp", "medium",
                          "system_package_install", "blocked")
        total, changes = rematch.run(apply=False)
        self.assertEqual(total, 3)
        self.assertEqual({c[0] for c in changes}, {1, 2})
        rematch.run(apply=True)
        rows = {r[0]: r for r in storage.iter_hook_pre_events()}
        self.assertIsNone(rows[1][3])
        self.assertEqual(rows[2][3], "history_read")
        self.assertEqual(rows[3][3], "system_package_install")
        conn = storage._connect()
        try:
            decisions = [r[0] for r in conn.execute("SELECT decision FROM events ORDER BY id")]
        finally:
            conn.close()
        self.assertEqual(decisions, ["allowed", "allowed", "blocked"])
        self.assertEqual(rematch.run(apply=False)[1], [])
        fp = policy.rules_fingerprint(policy.load_rules())
        self.assertEqual(storage.get_meta(rematch.FINGERPRINT_KEY), fp)
        # 指纹没变就不会再认领
        self.assertFalse(storage.claim_meta(rematch.FINGERPRINT_KEY, fp))
        self.assertTrue(storage.claim_meta(rematch.FINGERPRINT_KEY, "other"))


class HistoryReadTest(unittest.TestCase):
    BASH_HITS = [
        "cat ~/.zsh_history",
        "tail -n 50 ~/.zsh_history | grep AWS",
        "python3 -c \"open('/Users/me/.zsh_history').read()\"",
        "wc -l < ~/.zsh_history",
        "grep -i token $HISTFILE",
        "cat ~/.zsh_sessions/*.history",
        "cat ~/.claude/history.jsonl",
        "history | tail -20",
        "cd /tmp && history",
        "fc -l -50",
        "fc -ln 1",
    ]
    BASH_MISSES = [
        "grep -rn -i \"history\" . | head",
        "git log --oneline",
        "python3 fc.py -l",
        "ls docs/history",
    ]
    FILE_HITS = [
        ("Read", "/Users/me/.zsh_history"),
        ("Read", "/Users/me/.bash_history"),
        ("Read", "/Users/me/.zsh_sessions/abc.history"),
        ("Read", "/Users/me/.claude/history.jsonl"),
        ("Grep", "/Users/me/.zsh_history"),
    ]

    def test_bash_hits(self):
        for cmd in self.BASH_HITS:
            self.assertEqual(rule_id("Bash", command=cmd), "history_read", cmd)

    def test_bash_misses(self):
        for cmd in self.BASH_MISSES:
            self.assertIsNone(rule_id("Bash", command=cmd), cmd)

    def test_tampering_wins_over_read(self):
        for cmd in ["history -c", "rm -f ~/.zsh_history", ": > ~/.zsh_history", "rm -rf ~/.zsh_sessions/"]:
            self.assertEqual(rule_id("Bash", command=cmd), "history_tampering", cmd)

    def test_file_hits(self):
        for tool, path in self.FILE_HITS:
            self.assertEqual(rule_id(tool, file_path=path, path=path), "history_file_read", path)
        self.assertIsNone(rule_id("Read", file_path="/Users/me/proj/src/history.ts"))


if __name__ == "__main__":
    unittest.main()
