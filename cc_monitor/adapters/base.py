"""各适配器共用的小工具。"""
from .. import registry


def event(agent, mode, data, calls=None, prompt=None, extra=None, session_id=None, cwd=None, transcript_path=None):
    return {
        "agent": agent,
        "mode": mode,
        "session_id": session_id if session_id is not None else (data.get("session_id") or ""),
        "cwd": cwd if cwd is not None else (data.get("cwd") or ""),
        "transcript_path": transcript_path if transcript_path is not None else data.get("transcript_path"),
        "calls": calls or [],
        "prompt": prompt,
        "extra": extra or {},
    }


def call(agent, native_tool, native_input, tool_response=None, tool_name=None, tool_input=None):
    """一条规范化的工具调用。tool_name/tool_input 不传就按注册表映射；传了就用传的
    （apply_patch 这种要拆成多条、字段要自己拼的场景）。"""
    if not isinstance(native_input, dict):
        native_input = {} if native_input is None else {"value": native_input}
    return {
        "tool_name": tool_name if tool_name is not None else registry.map_tool(agent, native_tool),
        "tool_input": tool_input if tool_input is not None else registry.map_fields(agent, native_input),
        "native_tool": native_tool,
        "native_input": native_input,
        "tool_response": tool_response,
    }


def parse_apply_patch(patch_text):
    """Codex 的 apply_patch 格式：
        *** Begin Patch
        *** Add File: path      (后面是以 + 开头的新文件内容)
        *** Update File: path   (后面是 @@ hunk，+/- 行)
        *** Delete File: path
        *** End Patch
    拆成 [(op, path, content)]；content 是这个文件段落里 + 行的内容（Update 就是新增/改动
    的那些行，规则里 field=="content" 的检测看这个就够了）。"""
    files = []
    cur = None
    for line in (patch_text or "").splitlines():
        for op, prefix in (("add", "*** Add File: "), ("update", "*** Update File: "), ("delete", "*** Delete File: ")):
            if line.startswith(prefix):
                cur = [op, line[len(prefix):].strip(), []]
                files.append(cur)
                break
        else:
            if line.startswith("*** End Patch"):
                cur = None
            elif cur is not None and line.startswith("+"):
                cur[2].append(line[1:])
    return [(op, path, "\n".join(lines)) for op, path, lines in files]


def apply_patch_calls(agent, native_tool, native_input, patch_text):
    """apply_patch → 每个文件一条规范调用：Add→Write、Update→Edit、Delete→Edit(operation=delete)。
    这样 file_path 类规则和越界检测按文件逐个看；解析不出任何文件段落就退回一条 Edit，
    把整段 patch 当 content。"""
    files = parse_apply_patch(patch_text)
    if not files:
        return [call(agent, native_tool, native_input, tool_name="Edit", tool_input={"content": patch_text or ""})]
    out = []
    for op, path, content in files:
        tool_input = {"file_path": path, "content": content}
        if op == "delete":
            tool_input["operation"] = "delete"
        out.append(call(agent, native_tool, native_input, tool_name="Write" if op == "add" else "Edit", tool_input=tool_input))
    return out
