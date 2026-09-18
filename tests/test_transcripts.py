"""AI Tap 多格式解析：Claude Code / Antigravity CLI / Codex 三种 JSONL 行进同一个 describe_entry，
输出结构一致。Antigravity 的样例是真机 agy 1.2.6 写的行；Codex 的按公开资料构造。

直接跑：python3 -m unittest tests/test_transcripts.py
"""
import json
import os
import sys
import tempfile
import unittest

_TMP = tempfile.mkdtemp(prefix="cc-monitor-test-")
os.environ["CC_MONITOR_HOME"] = _TMP
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _REPO)

from cc_monitor import transcript  # noqa: E402

ANTIGRAVITY_LINES = [
    {"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE", "created_at": "2026-09-18T16:38:43Z",
     "content": "<USER_REQUEST>\nhi there\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: x\n</ADDITIONAL_METADATA>"},
    {"step_index": 1, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "created_at": "2026-09-18T16:43:49Z",
     "thinking": "Let me look.", "tool_calls": [{"name": "list_dir", "args": {"DirectoryPath": "\"/home/x\"", "toolAction": "\"Listing\""}}]},
    {"step_index": 2, "source": "MODEL", "type": "GENERIC", "status": "DONE", "created_at": "2026-09-18T16:43:54Z",
     "content": "Created At: ...\n{\"name\":\".git\",\"isDir\":true}"},
    {"step_index": 3, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "created_at": "2026-09-18T16:43:55Z",
     "content": "Done."},
]

CODEX_LINES = [
    {"timestamp": "2026-09-18T10:00:00Z", "type": "session_meta", "payload": {"id": "s", "cwd": "/p"}},
    {"timestamp": "2026-09-18T10:00:01Z", "type": "turn_context", "payload": {"model": "gpt-5-codex"}},
    {"timestamp": "2026-09-18T10:00:02Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "fix it"}]}},
    {"timestamp": "2026-09-18T10:00:03Z", "type": "response_item", "payload": {"type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking..."}]}},
    {"timestamp": "2026-09-18T10:00:04Z", "type": "response_item", "payload": {"type": "function_call", "name": "shell", "call_id": "c1", "arguments": "{\"command\": [\"ls\"]}"}},
    {"timestamp": "2026-09-18T10:00:05Z", "type": "response_item", "payload": {"type": "function_call_output", "call_id": "c1", "output": "a b c"}},
    {"timestamp": "2026-09-18T10:00:06Z", "type": "event_msg", "payload": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": 10, "output_tokens": 5, "cached_input_tokens": 3}}}},
    {"timestamp": "2026-09-18T10:00:07Z", "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "done"}]}},
]


class TestFormats(unittest.TestCase):
    def test_detect(self):
        self.assertEqual(transcript.detect_format(ANTIGRAVITY_LINES[0]), "antigravity")
        self.assertEqual(transcript.detect_format(CODEX_LINES[2]), "codex")
        self.assertEqual(transcript.detect_format({"type": "assistant", "message": {}}), "claude")

    def test_antigravity(self):
        es = [transcript.describe_entry(o) for o in ANTIGRAVITY_LINES]
        self.assertEqual(es[0]["kind"], "user")
        self.assertEqual(es[0]["blocks"][0]["text"], "hi there")  # 只留 <USER_REQUEST> 里的正文
        self.assertEqual(es[1]["kind"], "assistant")
        self.assertEqual([b["type"] for b in es[1]["blocks"]], ["thinking", "tool_use"])
        self.assertEqual(es[1]["blocks"][1]["input"]["DirectoryPath"], "/home/x")  # 拆掉多套的一层 JSON 引号
        self.assertEqual((es[2]["kind"], es[2]["blocks"][0]["type"]), ("user", "tool_result"))
        self.assertEqual(es[3]["blocks"], [{"type": "text", "text": "Done."}])

    def test_codex(self):
        es = [transcript.describe_entry(o) for o in CODEX_LINES]
        self.assertIsNone(es[0])
        self.assertEqual(es[1]["model"], "gpt-5-codex")
        self.assertEqual((es[2]["kind"], es[2]["blocks"][0]["text"]), ("user", "fix it"))
        self.assertEqual(es[3]["blocks"][0]["type"], "thinking")
        self.assertEqual((es[4]["blocks"][0]["name"], es[4]["blocks"][0]["input"]), ("shell", {"command": ["ls"]}))
        self.assertEqual(es[5]["blocks"][0]["content"], "a b c")
        self.assertEqual(es[6]["usage"]["input_tokens"], 10)
        self.assertEqual((es[7]["kind"], es[7]["blocks"][0]["text"]), ("assistant", "done"))

    def test_read_entries_mixed_file(self):
        path = os.path.join(_TMP, "t.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for o in ANTIGRAVITY_LINES:
                f.write(json.dumps(o) + "\n")
        entries, nxt = transcript.read_entries(path, 0, 100)
        self.assertEqual((len(entries), nxt), (4, 4))
        entries2, nxt2 = transcript.read_entries(path, nxt, 100)
        self.assertEqual((entries2, nxt2), ([], 4))

    def test_claude_format_unchanged(self):
        e = transcript.describe_entry({"type": "assistant", "timestamp": "t", "uuid": "u",
                                       "message": {"model": "claude-x", "content": [{"type": "text", "text": "hi"}], "usage": {"input_tokens": 1}}})
        self.assertEqual((e["kind"], e["model"], e["usage"]["input_tokens"]), ("assistant", "claude-x", 1))


if __name__ == "__main__":
    unittest.main()
