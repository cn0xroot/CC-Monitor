"""Cursor 的 hook 协议（~/.cursor/hooks.json，"version": 1）。

Cursor 的事件本身就是按"动作"分的，不像 Claude/Codex 那样一个 PreToolUse 带 tool_name：
  beforeShellExecution {command, cwd}                 → Bash
  beforeMCPExecution  {tool_name, tool_input, mcp_server_name, url|command} → mcp__<server>__<tool>
  beforeReadFile      {file_path, content, attachments} → Read
  afterFileEdit       {file_path, edits[{old_string,new_string}]} → Edit（事后事件，只能记不能拦，
                        但照样跑规则和越界检测，结果记成 observed）
  beforeSubmitPrompt  {prompt}                         → prompt
  preToolUse/postToolUse {tool_name, tool_input}       → 通用（按注册表映射）
基础字段：conversation_id（当 session_id）、generation_id、model、workspace_roots（首个当 cwd 的
兜底）、transcript_path。
输出：{"permission":"allow"|"deny"|"ask","user_message","agent_message"}；exit 2 也算 deny，其它
非 0 退出码 fail-open。
"""
import json
import os

from . import base, claude

AGENT = "cursor"
BLOCK_EXIT_CODE = 0

# afterFileEdit 这类事件虽然是 post，但它是 Cursor 唯一能看到"改了哪个文件"的地方——
# hook.py 对 evaluate_in_post=True 的 post 事件也跑一遍规则（只记录，不拦截）。


def parse(mode, data, agent=AGENT):
    native_event = data.get("hook_event_name", "")
    session_id = data.get("conversation_id") or data.get("session_id") or ""
    roots = data.get("workspace_roots") or []
    cwd = data.get("cwd") or (roots[0] if roots and isinstance(roots[0], str) else "")
    common = dict(session_id=session_id, cwd=cwd, transcript_path=data.get("transcript_path"))

    if native_event in ("beforeShellExecution", "afterShellExecution"):
        c = base.call(agent, native_event, data, tool_name="Bash",
                      tool_input={"command": data.get("command", "")},
                      tool_response={"output": data.get("output")} if native_event.startswith("after") else None)
        return base.event(agent, mode, data, calls=[c], **common)
    if native_event in ("beforeMCPExecution", "afterMCPExecution"):
        server = data.get("mcp_server_name") or "unknown"
        tool = data.get("tool_name") or "unknown"
        tool_input = data.get("tool_input")
        if isinstance(tool_input, str):
            try:
                tool_input = json.loads(tool_input)
            except ValueError:
                tool_input = {"value": tool_input}
        c = base.call(agent, native_event, data, tool_name="mcp__{}__{}".format(server, tool),
                      tool_input=tool_input if isinstance(tool_input, dict) else {},
                      tool_response={"result": data.get("result")} if native_event.startswith("after") else None)
        return base.event(agent, mode, data, calls=[c], **common)
    if native_event == "beforeReadFile":
        c = base.call(agent, native_event, {k: v for k, v in data.items() if k != "content"},
                      tool_name="Read", tool_input={"file_path": data.get("file_path", "")})
        return base.event(agent, mode, data, calls=[c], **common)
    if native_event == "afterFileEdit":
        edits = data.get("edits") or []
        new_text = "\n".join(e.get("new_string", "") for e in edits if isinstance(e, dict))
        c = base.call(agent, native_event, data, tool_name="Edit",
                      tool_input={"file_path": data.get("file_path", ""), "new_string": new_text})
        ev = base.event(agent, mode, data, calls=[c], **common)
        ev["extra"]["evaluate_in_post"] = True
        return ev
    if native_event == "beforeSubmitPrompt" or mode == "prompt":
        return base.event(agent, "prompt", data, prompt=data.get("prompt", ""), **common)
    if mode in ("pre", "post"):
        c = base.call(agent, data.get("tool_name", ""), data.get("tool_input", {}) or {},
                      tool_response=data.get("tool_response"))
        return base.event(agent, mode, data, calls=[c], **common)
    ev = claude.parse(mode, data, agent=agent)
    ev.update(common)
    if data.get("model"):
        ev["extra"]["model"] = data["model"]
    return ev


def emit_pre(decision):
    if decision["decision"] == "blocked":
        reason = decision.get("reason") or "CC-Monitor blocked"
        return json.dumps({"permission": "deny", "user_message": reason, "agent_message": reason}), BLOCK_EXIT_CODE
    if decision.get("handled_via_confirm"):
        return json.dumps({"permission": "allow"}), 0
    return None, 0


def emit_permission(behavior):
    return None


def hook_config_entries(hook_bin, agent, events):
    """Cursor 的 hooks.json 是 {"version":1,"hooks":{event:[{"command":...}]}}，条目里没有 type。"""
    hooks = {}
    for native, mode in events.items():
        hooks[native] = [{"command": '"{}" {} --agent {}'.format(hook_bin, mode, agent), "timeout": 100}]
    return hooks
