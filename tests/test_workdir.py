"""跨工作目录行为检测（cc_monitor/workdir.py + match="workdir" 规则）的回归测试。

直接跑：python3 -m unittest tests/test_workdir.py
HOME 固定成一个不存在的假家目录，路径判定不依赖跑测试这台机器上真实的目录结构；
CC_MONITOR_HOME 隔离，不碰 ~/.cc-monitor。
"""
import os
import sys
import tempfile
import unittest

_TMP = tempfile.mkdtemp(prefix="cc-monitor-test-")
os.environ["CC_MONITOR_HOME"] = _TMP
os.environ["HOME"] = "/home/alice"
os.environ.pop("TMPDIR", None)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cc_monitor import policy, workdir  # noqa: E402

CWD = "/home/alice/proj"


def hits(tool, **tool_input):
    return [(h.path, h.tier, h.access) for h in workdir.scan(tool, tool_input, CWD)]


def rule_id(tool, **tool_input):
    rule, _ = policy.evaluate(tool, tool_input, cwd=CWD)
    return rule["id"] if rule else None


class ClassifyTest(unittest.TestCase):
    def test_tiers(self):
        cases = {
            "/home/alice/proj/src/a.py": None,
            "/home/alice/proj": None,
            "/home/alice/projects": workdir.TIER_OTHER,  # 同前缀但不是子目录
            "/home/alice/.ssh/id_rsa": workdir.TIER_HOME_DOTFILE,
            "/home/alice/.config/gh/hosts.yml": workdir.TIER_HOME_DOTFILE,
            "/home/alice/other/x.py": workdir.TIER_OTHER,
            "/home/bob/x": workdir.TIER_OTHER_USER,
            "/Users/bob/x": workdir.TIER_OTHER_USER,
            "/root/.bashrc": workdir.TIER_OTHER_USER,
            "/etc/hosts": workdir.TIER_SYSTEM,
            "/usr/lib/x.so": workdir.TIER_SYSTEM,
            "/opt/app/conf": workdir.TIER_SYSTEM,
            "/Library/Preferences/x": workdir.TIER_SYSTEM,
            "/data/shared": workdir.TIER_OTHER,
            "/mnt/disk/x": workdir.TIER_OTHER,
            "/tmp/x": None,
            "/var/tmp/x": None,
            "/dev/null": None,
        }
        for path, expected in cases.items():
            self.assertEqual(workdir.classify(path, CWD, ignored_roots=workdir.DEFAULT_IGNORE), expected, path)

    def test_root_running_claude_in_user_home(self):
        # claude 用 root 跑（HOME=/root），项目在 /home/alice 下：/home/alice 是这个会话的
        # "自己家"，旁边的项目是 otherProject、隐藏文件是 homeDotfile，不是"别的用户"。
        os.environ["HOME"] = "/root"
        try:
            self.assertEqual(workdir.classify("/home/alice/other/x.py", CWD, ignored_roots=()), workdir.TIER_OTHER)
            self.assertEqual(workdir.classify("/home/alice/.ssh/id_rsa", CWD, ignored_roots=()), workdir.TIER_HOME_DOTFILE)
            self.assertEqual(workdir.classify("/root/.bashrc", CWD, ignored_roots=()), workdir.TIER_HOME_DOTFILE)
            self.assertEqual(workdir.classify("/home/bob/x", CWD, ignored_roots=()), workdir.TIER_OTHER_USER)
        finally:
            os.environ["HOME"] = "/home/alice"


class FileToolTest(unittest.TestCase):
    def test_inside_not_flagged(self):
        self.assertEqual(hits("Read", file_path="/home/alice/proj/README.md"), [])
        self.assertEqual(hits("Write", file_path="src/x.py", content="x"), [])
        self.assertEqual(hits("Edit", file_path="./a/../b.py", old_string="a", new_string="b"), [])
        self.assertEqual(hits("Grep", pattern="foo", path="/home/alice/proj/src"), [])

    def test_outside(self):
        self.assertEqual(hits("Read", file_path="/home/alice/other/README.md"), [("/home/alice/other/README.md", "otherProject", "read")])
        self.assertEqual(hits("Edit", file_path="../other/x.py", old_string="a", new_string="b"), [("/home/alice/other/x.py", "otherProject", "write")])
        self.assertEqual(hits("Write", file_path="~/.config/foo.toml", content="x"), [("/home/alice/.config/foo.toml", "homeDotfile", "write")])
        self.assertEqual(hits("Glob", pattern="**/*.py", path="/data/shared"), [("/data/shared", "otherProject", "read")])
        self.assertEqual(hits("NotebookEdit", notebook_path="/home/bob/nb.ipynb", new_source="x"), [("/home/bob/nb.ipynb", "otherUserHome", "write")])


class BashTest(unittest.TestCase):
    NOT_FLAGGED = [
        "ls -la",
        "ls src/ && cat README.md",
        "git status && git diff HEAD~1 -- src/a.py",
        "python3 -m pytest tests/ -k foo",
        "/usr/bin/python3 script.py --out=/tmp/x.json",  # 系统里的解释器 + 临时目录
        "curl https://example.com/a/b -o out.txt",
        'grep -rn "port install" docs/ | head',
        "python3 -c \"print('/etc/hostname')\"",  # 字符串里的路径不是在访问
        "ls 2>/dev/null; echo ok",
        "cat <<EOF > notes.txt\n/etc/hosts\n~/.ssh/id_rsa\nEOF",  # heredoc 正文不算
        "sed 's/a/b/' src/x.txt",
        "echo $FOO/bar",
        "cd src && ls ../tests",  # 在项目里转
        'echo "##### /service 与 /etc/sv 的关系"; ls -la service/drmlog | head -2',  # 引号里带空格的字符串不是路径
        "SP=/tmp/scratch; ./scripts/run.sh > $SP/out.txt 2>&1 <<'EOF'\ncat /var/log/x\nEOF",
    ]

    def test_not_flagged(self):
        for cmd in self.NOT_FLAGGED:
            self.assertEqual(hits("Bash", command=cmd), [], cmd)

    def test_quiet_reads_in_readonly_system_dirs(self):
        # 只读系统目录里的读不报（跑程序/查库/看头文件），写照样报
        for cmd in ["ls /usr/lib/x86_64-linux-gnu | grep libxcb", "cat /usr/include/xcb/xcb.h", "ls /opt/idapro/idalib",
                    "readlink -f /usr/lib/x86_64-linux-gnu/dri/virtio_gpu_dri.so", "ls ~/.cache/puppeteer", "file /bin/ls"]:
            self.assertEqual(hits("Bash", command=cmd), [], cmd)
        self.assertEqual(hits("Bash", command="cp x.so /usr/lib/x86_64-linux-gnu/x.so"), [("/usr/lib/x86_64-linux-gnu/x.so", "system", "write")])
        self.assertEqual(hits("Bash", command="echo x > ~/.cache/foo"), [("/home/alice/.cache/foo", "homeDotfile", "write")])
        # /etc、/proc、/var 这些放配置/状态的地方，读还是要报
        self.assertEqual(hits("Bash", command="cat /etc/hosts"), [("/etc/hosts", "system", "read")])
        self.assertEqual(hits("Bash", command="cat /proc/cpuinfo"), [("/proc/cpuinfo", "system", "read")])

    def test_claude_own_state_ignored(self):
        self.assertEqual(hits("Read", file_path="/home/alice/.claude/projects/-x/memory/MEMORY.md"), [])
        self.assertEqual(hits("Write", file_path="/home/alice/.claude/projects/-x/memory/note.md", content="x"), [])
        # 但 ~/.claude 下别的东西（settings/凭证）照常报
        self.assertEqual(hits("Read", file_path="/home/alice/.claude/settings.json"), [("/home/alice/.claude/settings.json", "homeDotfile", "read")])

    def test_symlink_created_in_ignored_dir_is_not_followed(self):
        # ln 的目标（链接本身）在 /tmp 里：按字面路径判定为忽略，不能 realpath 到它指向的 /usr/lib
        self.assertEqual(hits("Bash", command="ln -sf /usr/lib/libxcb.so.0 /tmp/build/usr/lib/libxcb.so"), [])
        self.assertEqual(hits("Bash", command="cd /tmp/build && ln -sf /usr/lib/libxcb.so.0 usr/lib/libxcb.so"), [])

    def test_reads(self):
        self.assertEqual(hits("Bash", command="cat /etc/os-release"), [("/etc/os-release", "system", "read")])
        self.assertEqual(hits("Bash", command="cat ~/.npmrc"), [("/home/alice/.npmrc", "homeDotfile", "read")])
        self.assertEqual(hits("Bash", command="cat $HOME/.npmrc"), [("/home/alice/.npmrc", "homeDotfile", "read")])
        self.assertEqual(hits("Bash", command="git -C ../sibling status"), [("/home/alice/sibling", "otherProject", "read")])
        self.assertEqual(hits("Bash", command="diff a.txt ../sibling/a.txt"), [("/home/alice/sibling/a.txt", "otherProject", "read")])
        self.assertEqual(hits("Bash", command="cat /home/bob/notes.txt"), [("/home/bob/notes.txt", "otherUserHome", "read")])

    def test_writes(self):
        self.assertEqual(hits("Bash", command="echo x > ~/.config/foo/bar.toml"), [("/home/alice/.config/foo/bar.toml", "homeDotfile", "write")])
        self.assertEqual(hits("Bash", command="echo x >> /etc/hosts"), [("/etc/hosts", "system", "write")])
        self.assertEqual(hits("Bash", command="sudo tee /etc/hosts <<EOF\n127.0.0.1 x\nEOF"), [("/etc/hosts", "system", "write")])
        self.assertEqual(hits("Bash", command="cp build/a.tgz /home/bob/a.tgz"), [("/home/bob/a.tgz", "otherUserHome", "write")])
        self.assertEqual(hits("Bash", command="cp ../other/a.txt ./a.txt"), [("/home/alice/other/a.txt", "otherProject", "read")])
        # 目标不带斜杠也是目标：来源 /etc/hosts 是读，不能因为目标认不出是路径就把来源当成写
        self.assertEqual(hits("Bash", command="cp /etc/hosts hosts.bak"), [("/etc/hosts", "system", "read")])
        self.assertEqual(hits("Bash", command="cp -r /etc/nginx nginx-backup"), [("/etc/nginx", "system", "read")])
        self.assertEqual(hits("Bash", command="ln -sfn /run/service/x extracted/etc/sv/x"), [("/run/service/x", "system", "read")])
        self.assertEqual(hits("Bash", command="bash -c 'rm -rf ~/.cache/foo'"), [("/home/alice/.cache/foo", "homeDotfile", "write")])
        self.assertEqual(hits("Bash", command="sed -i 's/a/b/' /opt/app/conf.ini"), [("/opt/app/conf.ini", "system", "write")])
        self.assertEqual(hits("Bash", command="tar -xzf a.tgz -C /opt/app"), [("/opt/app", "system", "write")])
        self.assertEqual(hits("Bash", command="mkdir -p /root/.ssh"), [("/root/.ssh", "otherUserHome", "write")])
        self.assertEqual(hits("Bash", command="git clone https://x/y.git ../y"), [("/home/alice/y", "otherProject", "write")])
        self.assertEqual(hits("Bash", command="rsync -a dist/ /data/www/"), [("/data/www", "otherProject", "write")])

    def test_cd_tracking(self):
        self.assertEqual(hits("Bash", command="cd ../other-proj && cat src/x.py"), [
            ("/home/alice/other-proj", "otherProject", "read"),
            ("/home/alice/other-proj/src/x.py", "otherProject", "read"),
        ])
        self.assertEqual(hits("Bash", command="cd .. && rm -rf other-proj/dist"), [
            ("/home/alice", "otherProject", "read"),
            ("/home/alice/other-proj/dist", "otherProject", "write"),
        ])
        self.assertEqual(hits("Bash", command="cd /var/log; tail -f syslog"), [("/var/log", "system", "read")])

    def test_write_wins_over_read_for_same_path(self):
        self.assertEqual(hits("Bash", command="cat ~/.npmrc; echo x > ~/.npmrc"), [("/home/alice/.npmrc", "homeDotfile", "write")])


class ProjectRootTest(unittest.TestCase):
    """Claude Code 的 Bash 工具 cd 进子目录后 hook 里的 cwd 也跟着变——"在不在项目里"
    要按项目根（往上找 .git 等标记）判断，不按 cwd。"""

    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="cc-monitor-proj-")
        self.proj = os.path.join(self.base, "proj")
        os.makedirs(os.path.join(self.proj, ".git"))
        os.makedirs(os.path.join(self.proj, "webui", "public"))
        os.makedirs(os.path.join(self.base, "other"))
        # 临时目录在 /tmp 下会被整体忽略，测试里把 base 当"家目录"来绕开这一点
        os.environ["HOME"] = self.base
        workdir.DEFAULT_IGNORE, self._saved_ignore = (), workdir.DEFAULT_IGNORE

    def tearDown(self):
        os.environ["HOME"] = "/home/alice"
        workdir.DEFAULT_IGNORE = self._saved_ignore

    def test_project_root_found_from_subdir(self):
        self.assertEqual(workdir.project_root(os.path.join(self.proj, "webui", "public")), self.proj)
        self.assertEqual(workdir.project_root(self.proj), self.proj)
        self.assertEqual(workdir.project_root(os.path.join(self.base, "other")), os.path.join(self.base, "other"))

    def test_edit_in_parent_of_cwd_is_inside_project(self):
        cwd = os.path.join(self.proj, "webui")
        inside = [h.path for h in workdir.scan("Edit", {"file_path": os.path.join(self.proj, "README.md"), "old_string": "a", "new_string": "b"}, cwd)]
        self.assertEqual(inside, [])
        inside = [h.path for h in workdir.scan("Bash", {"command": "cat ../CHANGELOG.md && ls ../cc_monitor"}, cwd)]
        self.assertEqual(inside, [])
        outside = [(h.path, h.tier) for h in workdir.scan("Read", {"file_path": os.path.join(self.base, "other", "x.py")}, cwd)]
        self.assertEqual(outside, [(os.path.join(self.base, "other", "x.py"), "otherProject")])


class RuleIntegrationTest(unittest.TestCase):
    def test_rule_mapping(self):
        self.assertEqual(rule_id("Bash", command="echo x > ~/.config/foo.toml"), "workdir_escape_write_sensitive")
        self.assertEqual(rule_id("Bash", command="mkdir -p /root/.ssh"), "workdir_escape_write_sensitive")
        self.assertEqual(rule_id("Write", file_path="/home/alice/other/x.py", content="x"), "workdir_escape_write_other")
        self.assertEqual(rule_id("Bash", command="cat ~/.npmrc"), "workdir_escape_read_sensitive")
        self.assertEqual(rule_id("Bash", command="cat /etc/os-release"), "workdir_escape_read_other")
        self.assertEqual(rule_id("Read", file_path="/home/alice/other/README.md"), "workdir_escape_read_other")
        self.assertIsNone(rule_id("Read", file_path="/home/alice/proj/README.md"))
        self.assertIsNone(rule_id("Bash", command="ls -la"))

    def test_specific_rules_still_win(self):
        # 已有的更具体的规则排在前面，先命中它们——跨目录规则只兜底。
        self.assertEqual(rule_id("Bash", command="cat ~/.ssh/config"), "sensitive_file_read_bash")
        self.assertEqual(rule_id("Write", file_path="/home/alice/.ssh/authorized_keys", content="x"), "sensitive_file_write")

    def test_matched_value_shows_paths(self):
        rule, value = policy.evaluate("Bash", {"command": "cp a.txt ~/other/a.txt; cp b.txt ~/other/b.txt"}, cwd=CWD)
        self.assertEqual(rule["id"], "workdir_escape_write_other")
        self.assertEqual(value, "~/other/a.txt, ~/other/b.txt")

    def test_without_cwd_never_matches(self):
        rule, _ = policy.evaluate("Bash", {"command": "cat /etc/os-release"})
        self.assertIsNone(rule)

    def test_ignore_paths_in_rule(self):
        rules = [dict(r) for r in policy.load_rules()]
        for r in rules:
            if r["id"] == "workdir_escape_read_other":
                r["ignore_paths"] = ["/etc"]
        rule, _ = policy.evaluate("Bash", {"command": "cat /etc/os-release"}, rules=rules, cwd=CWD)
        self.assertIsNone(rule)


if __name__ == "__main__":
    unittest.main()
