"""OpenAI Codex CLI 的 hook 协议（~/.codex/hooks.json 或 config.toml [hooks]）。

跟 Claude Code 的协议同构：事件名（PreToolUse/PostToolUse/PermissionRequest/...）、stdin 字段
（tool_name/tool_input/session_id/cwd/transcript_path，多一个 turn_id）、拦截方式
（hookSpecificOutput.permissionDecision=deny 或 exit 2）都一样。差异只有两点：
  1. 工具名：Bash 同名；改文件走 apply_patch（一个调用改多个文件，patch 文本在 tool_input.patch
     或 tool_input.input 里），拆成逐文件的 Write/Edit。
  2. 不支持 permissionDecision="ask"——我们的 confirm 流程本来就是自己问完给 allow/deny，不受影响。
需要 config.toml 里 [features] hooks = true（默认值以实测为准，install.py 会检查并提示）。
"""
import json

from . import base, claude

AGENT = "codex"
BLOCK_EXIT_CODE = 2

PATCH_FIELDS = ("patch", "input", "patch_text", "content")


def parse(mode, data, agent=AGENT):
    if mode in ("pre", "post", "permission"):
        tool_name = data.get("tool_name", "")
        tool_input = data.get("tool_input", {}) or {}
        tool_response = data.get("tool_response", {})
        if tool_name == "apply_patch" or (isinstance(tool_input, dict) and _looks_like_patch(tool_input)):
            patch_text = _patch_text(tool_input)
            calls = base.apply_patch_calls(agent, tool_name, tool_input, patch_text)
            for c in calls:
                c["tool_response"] = tool_response
        else:
            calls = [base.call(agent, tool_name, tool_input, tool_response=tool_response)]
        ev = base.event(agent, mode, data, calls=calls)
        if data.get("turn_id"):
            ev["extra"]["turn_id"] = data["turn_id"]
        return ev
    return claude.parse(mode, data, agent=agent)


def _patch_text(tool_input):
    for k in PATCH_FIELDS:
        v = tool_input.get(k)
        if isinstance(v, str) and v:
            return v
    return ""


def _looks_like_patch(tool_input):
    return any(isinstance(tool_input.get(k), str) and tool_input[k].lstrip().startswith("*** Begin Patch") for k in PATCH_FIELDS)


def emit_pre(decision):
    if decision["decision"] == "blocked":
        # 两种写法都被 Codex 认；JSON 那种拒绝理由能完整带给模型，exit 2 的 stderr 也行。
        # 用 JSON + exit 0，避免某些版本把非零退出码当 hook 故障处理成 fail-open。
        return json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": decision.get("reason") or "CC-Monitor blocked",
            }
        }), 0
    return claude.emit_pre(decision)


emit_permission = claude.emit_permission


def hook_config_entries(hook_bin, agent, events):
    return claude.hook_config_entries(hook_bin, agent, events)
