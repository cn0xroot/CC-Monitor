"""superagent-ai/grok-cli（Bun 运行时，命令 `grok`）的 hook 协议——**实验性，未在真机上验证**，
按其源码 src/hooks/{types,executor,config}.ts 实现：
  配置：只读 ~/.grok/user-settings.json 的 "hooks" 键（项目级 .grok/settings.json 的 hooks 被它
  有意忽略），形状与 Claude Code 相同：{"PreToolUse": [{"matcher": "...", "hooks": [{"type": "command",
  "command": "...", "timeout": 秒}]}]}。
  事件：PreToolUse / PostToolUse / PostToolUseFailure / UserPromptSubmit / SessionStart / SessionEnd /
  Stop / StopFailure / SubagentStart / SubagentStop / TaskCreated / TaskCompleted / PreCompact /
  PostCompact / Notification / InstructionsLoaded / CwdChanged。
  stdin：hook_event_name、session_id、cwd、tool_name、tool_input（post 多 tool_output，失败多 error，
  prompt 事件字段叫 user_prompt）。
  输出：退出码 2 = 阻断（stderr 反馈给模型），其它非 0 = 非阻断错误；stdout JSON
  {"decision": "approve"|"block", "reason": ...}。没有"跳过原生确认"的语义。
  工具：bash(command) / read_file(path) / write_file(path, content) / edit_file(path, old_string, new_string) /
  grep(pattern) / search_web / search_x / task / delegate / lsp / computer_* ……
"""
from . import base, claude

AGENT = "grok-cli"
BLOCK_EXIT_CODE = 2


def parse(mode, data, agent=AGENT):
    if mode in ("pre", "post"):
        native_tool = data.get("tool_name", "")
        native_input = data.get("tool_input", {}) or {}
        resp = data.get("tool_output")
        if data.get("error"):
            resp = {"error": data["error"]}
        return base.event(agent, mode, data, calls=[base.call(agent, native_tool, native_input, tool_response=resp)])
    if mode == "prompt":
        return base.event(agent, mode, data, prompt=data.get("user_prompt") or data.get("prompt") or "")
    ev = claude.parse(mode, data, agent=agent)
    for k in ("agent_type", "description", "success"):
        if k in data:
            ev["extra"][k] = data[k]
    return ev


def emit_pre(decision):
    # 退出码 2 是它明确的"阻断"语义，stderr 会反馈给模型；同时给 JSON，两条路都认。
    if decision["decision"] == "blocked":
        return '{"decision": "block", "reason": "' + (decision.get("reason") or "CC-Monitor blocked").replace('"', "'") + '"}', BLOCK_EXIT_CODE
    return None, 0


def emit_permission(behavior):
    return None


def hook_config_entries(hook_bin, agent, events):
    hooks = {}
    for native, mode in events.items():
        hooks[native] = [{"matcher": "*", "hooks": [{"type": "command",
                          "command": '"{}" {} --agent {}'.format(hook_bin, mode, agent), "timeout": 100}]}]
    return hooks
