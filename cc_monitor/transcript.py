"""Claude Tap：解析各家 agent 本地写的 transcript，把它实际发给模型 / 从模型收到的完整对话内容
（文本、思考、工具调用、工具结果、token 用量）转成结构化的"轮次"数据，供 CLI (`CC-Monitor tap`)
和 Web UI 渲染。

这不是网络抓包/MITM——transcript 是 agent 自己已经写在本地磁盘上的东西，本来就在这台机器上，
不需要解密 TLS 流量。

认三种 JSONL 格式，按每一行的形状自动识别（同一个 describe_entry 入口，输出结构完全一样）：
  - Claude Code  ~/.claude/projects/<cwd>/<session>.jsonl：{type: user|assistant|attachment, message: {...}}
  - Antigravity CLI  ~/.gemini/antigravity-cli/brain/<conv>/.system_generated/logs/transcript.jsonl：
    {step_index, source: USER_EXPLICIT|MODEL, type: USER_INPUT|PLANNER_RESPONSE|GENERIC, content, thinking, tool_calls}
    （真机 agy 1.2.6 抓到的）
  - Codex CLI  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl：{timestamp, type: response_item|event_msg|…, payload}
    （按公开资料实现，未在真机验证）
Gemini CLI 的 chats/session-*.json 是整块 JSON 不是 JSONL，还没接。
"""
import json
import re

from . import colors as col
from . import format as fmt


def count_lines(path):
    n = 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for _ in f:
                n += 1
    except OSError:
        return 0
    return n


def _normalize_content(content):
    if content is None:
        return []
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


_USER_REQUEST_RE = re.compile(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", re.DOTALL)


def _unquote_arg(v):
    """Antigravity 把工具入参每个值都再 JSON 编码了一层（"\"/home/x\""），拆掉那一层。"""
    if isinstance(v, str) and len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def _describe_antigravity(obj):
    ts = obj.get("created_at")
    uuid = "step-{}".format(obj.get("step_index"))
    etype = obj.get("type")
    if etype == "USER_INPUT":
        content = obj.get("content") or ""
        m = _USER_REQUEST_RE.search(content)
        text = m.group(1) if m else content
        return {"kind": "user", "ts": ts, "uuid": uuid, "blocks": [{"type": "text", "text": text}], "usage": None, "model": None}
    if etype == "PLANNER_RESPONSE":
        blocks = []
        if obj.get("thinking"):
            blocks.append({"type": "thinking", "thinking": obj["thinking"]})
        if obj.get("content"):
            blocks.append({"type": "text", "text": obj["content"]})
        for tc in obj.get("tool_calls") or []:
            if isinstance(tc, dict):
                args = tc.get("args") or {}
                blocks.append({"type": "tool_use", "name": tc.get("name", ""),
                               "input": {k: _unquote_arg(v) for k, v in args.items()} if isinstance(args, dict) else args})
        return {"kind": "assistant", "ts": ts, "uuid": uuid, "blocks": blocks, "usage": None, "model": obj.get("model")}
    if etype == "GENERIC" and obj.get("source") == "MODEL":
        # 工具执行结果（Antigravity 把它记成 MODEL 来源的 GENERIC 步骤）
        return {"kind": "user", "ts": ts, "uuid": uuid,
                "blocks": [{"type": "tool_result", "content": obj.get("content") or ""}], "usage": None, "model": None}
    return None


def _describe_codex(obj):
    ts = obj.get("timestamp")
    payload = obj.get("payload") or {}
    ptype = payload.get("type")
    uuid = payload.get("id") or payload.get("call_id")
    if obj.get("type") == "response_item":
        if ptype == "message":
            role = payload.get("role")
            texts = []
            for c in payload.get("content") or []:
                if isinstance(c, dict) and isinstance(c.get("text"), str):
                    texts.append(c["text"])
                elif isinstance(c, str):
                    texts.append(c)
            blocks = [{"type": "text", "text": "\n".join(texts)}]
            return {"kind": "assistant" if role == "assistant" else "user", "ts": ts, "uuid": uuid,
                    "blocks": blocks, "usage": None, "model": None}
        if ptype == "reasoning":
            text = "\n".join(s_.get("text", "") for s_ in payload.get("summary") or [] if isinstance(s_, dict))
            return {"kind": "assistant", "ts": ts, "uuid": uuid, "blocks": [{"type": "thinking", "thinking": text}], "usage": None, "model": None}
        if ptype in ("function_call", "custom_tool_call"):
            args = payload.get("arguments") if ptype == "function_call" else payload.get("input")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {"input": args}
            return {"kind": "assistant", "ts": ts, "uuid": uuid,
                    "blocks": [{"type": "tool_use", "name": payload.get("name", ""), "input": args or {}}], "usage": None, "model": None}
        if ptype in ("function_call_output", "custom_tool_call_output"):
            return {"kind": "user", "ts": ts, "uuid": uuid,
                    "blocks": [{"type": "tool_result", "content": payload.get("output") or ""}], "usage": None, "model": None}
        return None
    if obj.get("type") == "event_msg":
        if ptype == "token_count":
            info = payload.get("info") or {}
            last = info.get("last_token_usage") or info.get("total_token_usage") or {}
            if last:
                return {"kind": "assistant", "ts": ts, "uuid": uuid, "blocks": [],
                        "usage": {"input_tokens": last.get("input_tokens", 0), "output_tokens": last.get("output_tokens", 0),
                                  "cache_read_input_tokens": last.get("cached_input_tokens", 0)}, "model": None}
        return None
    if obj.get("type") == "turn_context" and payload.get("model"):
        return {"kind": "system", "ts": ts, "uuid": uuid, "blocks": [], "usage": None, "model": payload["model"]}
    return None


def detect_format(obj):
    """按一行的形状认格式：claude / antigravity / codex / None。"""
    if "step_index" in obj and "source" in obj:
        return "antigravity"
    if "payload" in obj and obj.get("type") in ("response_item", "event_msg", "session_meta", "turn_context"):
        return "codex"
    if obj.get("type") in ("user", "assistant", "attachment", "summary", "file-history-snapshot", "system"):
        return "claude"
    return None


def describe_entry(obj):
    """把 transcript 里的一行原始 JSON 翻译成 {kind, ts, uuid, blocks, usage, model}，
    不认识的行类型（summary/file-history-snapshot 等）返回 None，调用方直接跳过。
    Claude Code / Antigravity CLI / Codex 三种格式自动识别。"""
    fmt_name = detect_format(obj)
    if fmt_name == "antigravity":
        return _describe_antigravity(obj)
    if fmt_name == "codex":
        return _describe_codex(obj)
    etype = obj.get("type")
    ts = obj.get("timestamp")
    uuid = obj.get("uuid")

    if etype == "user":
        msg = obj.get("message", {}) or {}
        blocks = _normalize_content(msg.get("content"))
        return {"kind": "user", "ts": ts, "uuid": uuid, "blocks": blocks, "usage": None, "model": None}

    if etype == "assistant":
        msg = obj.get("message", {}) or {}
        blocks = _normalize_content(msg.get("content"))
        return {
            "kind": "assistant",
            "ts": ts,
            "uuid": uuid,
            "blocks": blocks,
            "usage": msg.get("usage"),
            "model": msg.get("model"),
        }

    if etype == "attachment":
        att = obj.get("attachment", {}) or {}
        text = att.get("text")
        if text is None:
            text = json.dumps(att, ensure_ascii=False)[:500]
        return {"kind": "system", "ts": ts, "uuid": uuid, "blocks": [{"type": "text", "text": text}], "usage": None, "model": None}

    return None


def read_entries(path, start_line=0, limit=500):
    """从第 start_line 行（0-based，之前已经读过多少行）之后开始读，最多返回 limit 条解析结果。
    返回 (entries, next_line)，next_line 交给下一次调用当 start_line 用，实现增量 tail。"""
    entries = []
    next_line = start_line
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for i, raw in enumerate(f):
                if i < start_line:
                    continue
                next_line = i + 1
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                entry = describe_entry(obj)
                if entry is not None:
                    entries.append(entry)
                if len(entries) >= limit:
                    break
    except OSError:
        pass
    return entries, next_line


KIND_LABEL = {"user": "用户", "assistant": "Claude", "system": "系统"}
KIND_COLOR = {"user": "cyan", "assistant": "green", "system": "gray"}


def render_entry_cli(entry):
    """把一条 entry 渲染成若干行终端文本（带 ANSI 颜色），供 `CC-Monitor tap` 打印。"""
    kind = entry["kind"]
    lines = []
    header = "[{}] {}".format(
        (entry.get("ts") or "")[:19].replace("T", " "),
        col.c(KIND_LABEL.get(kind, kind), color=KIND_COLOR.get(kind, "gray"), bold=True),
    )
    if kind == "assistant" and entry.get("usage"):
        u = entry["usage"]
        header += "  " + col.c(
            "in={} out={} cache_read={}".format(
                u.get("input_tokens", 0), u.get("output_tokens", 0), u.get("cache_read_input_tokens", 0)
            ),
            dim=True,
        )
    lines.append(header)
    for block in entry["blocks"]:
        lines.extend(_render_block_cli(block))
    return lines


def _render_block_cli(block):
    btype = block.get("type")
    out = []
    if btype == "text":
        text = (block.get("text") or "").strip()
        if text:
            out.append("  " + fmt._collapse(text, 600))
    elif btype == "thinking":
        text = (block.get("thinking") or "").strip()
        shown = text[:300] if text else "(内容已省略)"
        out.append("  " + col.c("💭 思考: ", dim=True) + col.c(shown, dim=True))
    elif btype == "tool_use":
        name = block.get("name", "?")
        inp = block.get("input", {}) or {}
        prefix = col.c("🔧 调用 {}: ".format(name), color="blue", bold=True)
        if name == "Bash" and "command" in inp:
            out.append("  " + prefix + fmt._highlight_bash(fmt._collapse(inp.get("command", ""), 300)))
        else:
            out.append("  " + prefix + fmt._collapse(json.dumps(inp, ensure_ascii=False), 300))
    elif btype == "tool_result":
        content = block.get("content")
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        is_error = bool(block.get("is_error"))
        rendered = fmt._highlight_log(fmt._collapse(text, 400))
        prefix = (
            col.c("✗ 工具结果(错误): ", color="bright_red", bold=True)
            if is_error
            else col.c("✓ 工具结果: ", color="green")
        )
        out.append("  " + prefix + rendered)
    elif btype == "image":
        out.append("  " + col.c("🖼 [图片内容，未显示]", dim=True))
    else:
        out.append("  " + col.c("[{}]".format(btype), dim=True))
    return out
