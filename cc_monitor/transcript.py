"""Claude Tap：解析 Claude Code 本地写的 transcript (~/.claude/projects/.../<session>.jsonl)，
把它实际发给模型 / 从模型收到的完整对话内容（文本、思考、工具调用、工具结果、token 用量）
转成结构化的"轮次"数据，供 CLI (`CC-Monitor tap`) 和 Web UI 渲染。

这不是网络抓包/MITM——transcript 是 Claude Code 自己已经写在本地磁盘上的东西，
本来就在这台机器上，不需要解密 TLS 流量。
"""
import json

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


def describe_entry(obj):
    """把 transcript 里的一行原始 JSON 翻译成 {kind, ts, uuid, blocks, usage, model}，
    不认识的行类型（summary/file-history-snapshot 等）返回 None，调用方直接跳过。"""
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
