"""ZCode（Z.ai 的 agentic 开发环境，GLM 模型）的 hook 协议。

官方文档（zcode.z.ai/docs/hooks）：hook 是本地子进程协议，stdin 一行 JSON，同时带 camelCase
和 Claude Code 的 snake_case 别名（session_id / transcript_path / cwd / tool_name / tool_input /
tool_use_id / permission_mode），工具名就是 Claude Code 的（Bash / Read / Write / Edit / MultiEdit /
Glob / Grep / WebFetch / Task，Agent 是 Task 的别名），拒绝方式也一样（PreToolUse 用
hookSpecificOutput.permissionDecision=deny，PermissionRequest 用 decision.behavior=deny，exit 2
也算拒绝）。所以解析和输出直接复用 Claude 适配器。

差异只在配置文件：~/.zcode/cli/config.json，形状是
    {"hooks": {"enabled": true, "events": {"PreToolUse": [{"matcher": ".*", "hooks": [{"type": "process",
                "command": "<bin>", "args": ["pre", "--agent", "zcode"]}]}]}}}
（type=process 按 argv 执行，不经 shell；项目级 .zcode/config.json 里的 hooks 当前版本被 ZCode 忽略）。
事件只有七个：SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse /
PostToolUseFailure / Stop——没有 SessionEnd / PreCompact / SubagentStop。
PostToolUseFailure 带 error / is_interrupt，这里记成 post 事件、tool_response 里放错误。
"""
from .. import registry
from . import base, claude

AGENT = "zcode"
BLOCK_EXIT_CODE = claude.BLOCK_EXIT_CODE


def parse(mode, data, agent=AGENT):
    if mode == "post" and (data.get("hook_event_name") or data.get("hookEventName")) == "PostToolUseFailure":
        tool_name = data.get("tool_name", "")
        tool_input = data.get("tool_input", {}) or {}
        c = base.call(agent, tool_name, tool_input, tool_name=tool_name,
                      tool_input=tool_input if isinstance(tool_input, dict) else {},
                      tool_response={"error": data.get("error"), "is_interrupt": data.get("is_interrupt", False)})
        return base.event(agent, mode, data, calls=[c])
    ev = claude.parse(mode, data, agent=agent)
    for c in ev["calls"]:
        # Claude 协议本身不翻译工具名；ZCode 的 Agent 是 Task 的别名，按注册表 tools 映射一下
        mapped = registry.map_tool(agent, c["tool_name"])
        if mapped != c["tool_name"]:
            c["native_tool"], c["tool_name"] = c["tool_name"], mapped
    if mode == "stop" and data.get("last_assistant_message"):
        ev["extra"]["last_assistant_message"] = str(data["last_assistant_message"])[:2000]
    return ev


emit_pre = claude.emit_pre
emit_permission = claude.emit_permission


def hook_config_entries(hook_bin, agent, events):
    """ZCode 的 hooks.events 块：type=process，命令和参数分开给（不用管 shell 引号）。"""
    hooks = {}
    for native, mode in events.items():
        hooks[native] = [{
            "matcher": ".*",
            "hooks": [{"type": "process", "command": hook_bin, "args": [mode, "--agent", agent],
                       "enabled": True, "timeoutMs": 100000}],
        }]
    return hooks
