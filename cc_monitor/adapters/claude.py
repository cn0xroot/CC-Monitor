"""Claude Code 的 hook 协议——也是"规范协议"：工具名和字段名就是规范词汇，不用翻译。
Codex 的协议跟这个几乎一样，见 codex.py。"""
import json

from . import base

AGENT = "claude-code"

# 拦截 = exit 2 + stderr（Claude Code 会把 stderr 喂给模型当拒绝理由）。
BLOCK_EXIT_CODE = 2


def parse(mode, data, agent=AGENT):
    if mode in ("pre", "post", "permission"):
        tool_name = data.get("tool_name", "")
        tool_input = data.get("tool_input", {}) or {}
        calls = _calls(agent, tool_name, tool_input, data.get("tool_response", {}))
        return base.event(agent, mode, data, calls=calls)
    if mode == "prompt":
        return base.event(agent, mode, data, prompt=data.get("prompt", ""))
    extra = {}
    if mode == "session_start":
        extra = {"source": data.get("source", "")}
    elif mode == "session_end":
        extra = {"reason": data.get("reason", "")}
    elif mode == "precompact":
        extra = {"trigger": data.get("trigger", ""), "custom_instructions": data.get("custom_instructions", "")}
    elif mode in ("stop", "subagent_stop"):
        extra = {"stop_hook_active": data.get("stop_hook_active", False)}
    return base.event(agent, mode, data, extra=extra)


def _calls(agent, tool_name, tool_input, tool_response):
    return [base.call(agent, tool_name, tool_input, tool_response=tool_response,
                      tool_name=tool_name, tool_input=tool_input if isinstance(tool_input, dict) else {})]


def emit_pre(decision):
    if decision["decision"] == "blocked":
        return None, BLOCK_EXIT_CODE
    if decision.get("handled_via_confirm"):
        # 只有真的走过我们自己的 confirm 流程才输出 permissionDecision=allow，让 Claude Code
        # 跳过它自己原生的"Do you want to proceed?"弹窗；没被我们审查过的工具不碰这个
        # 字段，Claude Code 自己的默认询问该弹还弹。
        return json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "CC-Monitor: {} 已批准".format(decision.get("rule_id")),
            }
        }), 0
    return None, 0


def emit_permission(behavior):
    # 按文档的字段形状：decision.message 只对 deny 有意义，allow 不带多余字段。
    d = {"behavior": behavior}
    if behavior == "deny":
        d["message"] = "CC-Monitor: 用户在 AI 审批台拒绝了这次操作"
    return json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": d}})


def hook_config_entries(hook_bin, agent, events):
    """install.py 用：这个协议的 hooks 配置块长什么样。events 是 {原生事件名: 我们的模式}。"""
    hooks = {}
    for native, mode in events.items():
        hooks[native] = [{"matcher": "*", "hooks": [{"type": "command", "command": _cmd(hook_bin, mode, agent)}]}]
    return hooks


def _cmd(hook_bin, mode, agent):
    cmd = '"{}" {}'.format(hook_bin, mode)
    if agent != AGENT:
        cmd += " --agent {}".format(agent)
    return cmd
