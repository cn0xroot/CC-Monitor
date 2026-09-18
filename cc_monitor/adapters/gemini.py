"""Google Gemini CLI 的 hook 协议（~/.gemini/settings.json 的 "hooks" 块）。

事件：BeforeTool / AfterTool（工具调用前后）、BeforeAgent（用户提交 prompt 之后、规划之前）、
SessionStart / SessionEnd / PreCompress / AfterAgent。stdin 字段：session_id、transcript_path、cwd、
hook_event_name、timestamp、tool_name、tool_input（AfterTool 多 tool_response）、mcp_context。
工具名是 snake_case（run_shell_command / read_file / write_file / replace / glob / ...），MCP 工具
带 mcp_context.server_name。
输出：拒绝 = {"decision":"deny","reason":...}（exit 0 或 2 都行）；允许 = {"decision":"allow"}；
什么都不输出 = 不表态。
"""
import json

from . import base, claude

AGENT = "gemini-cli"
BLOCK_EXIT_CODE = 0


def parse(mode, data, agent=AGENT):
    if mode in ("pre", "post"):
        native_tool = data.get("tool_name", "")
        native_input = data.get("tool_input", {}) or {}
        c = base.call(agent, native_tool, native_input, tool_response=data.get("tool_response"))
        mcp = data.get("mcp_context")
        if isinstance(mcp, dict) and (mcp.get("server_name") or mcp.get("serverName")):
            # 规范化成 Claude Code 的 mcp__<server>__<tool>，让 mcp_suspicious_tool_name 那类规则和
            # Web UI 的 MCP 统计直接认。
            server = mcp.get("server_name") or mcp.get("serverName")
            tool = mcp.get("tool_name") or mcp.get("toolName") or native_tool
            c["tool_name"] = "mcp__{}__{}".format(server, tool)
        elif c["tool_name"] == "WebFetch" and "url" not in c["tool_input"]:
            # Gemini 的 web_fetch 入参是一段带 URL 的 prompt；把它同时放到 url 字段，
            # 现有的 URL 类规则才看得到。
            p = c["tool_input"].get("prompt")
            if isinstance(p, str):
                c["tool_input"]["url"] = p
        return base.event(agent, mode, data, calls=[c])
    if mode == "prompt":
        return base.event(agent, mode, data, prompt=data.get("prompt") or data.get("user_prompt") or "")
    return claude.parse(mode, data, agent=agent)


def emit_pre(decision):
    if decision["decision"] == "blocked":
        return json.dumps({"decision": "deny", "reason": decision.get("reason") or "CC-Monitor blocked"}), BLOCK_EXIT_CODE
    if decision.get("handled_via_confirm"):
        return json.dumps({"decision": "allow"}), 0
    return None, 0


def emit_permission(behavior):
    return None  # Gemini 没有 PermissionRequest 类事件


def hook_config_entries(hook_bin, agent, events):
    hooks = {}
    for native, mode in events.items():
        cmd = '"{}" {} --agent {}'.format(hook_bin, mode, agent)
        hooks[native] = [{
            "matcher": ".*",
            "sequential": False,
            "hooks": [{"type": "command", "name": "CC-Monitor", "command": cmd, "timeout": 100000}],
        }]
    return hooks
