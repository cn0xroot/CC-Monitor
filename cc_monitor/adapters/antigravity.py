"""Google Antigravity CLI（`agy`，Go 二进制）的 hook 协议——**实验性，未在真机上验证**。

官方文档（antigravity.google/docs/hooks）：
  配置：~/.gemini/config/hooks.json（全局，CLI 与 IDE 共用）或工作区 .agents/hooks.json，形状按
  "hook 名"分组：
    {"cc-monitor": {"enabled": true,
       "PreToolUse":  [{"matcher": "*", "hooks": [{"type": "command", "command": "...", "timeout": 100}]}],
       "PostToolUse": [{...同上...}],
       "PreInvocation": [{"type": "command", "command": "...", "timeout": 100}],
       "PostInvocation": [...], "Stop": [...]}}
  事件只有五个：PreToolUse / PostToolUse / PreInvocation / PostInvocation / Stop。
  stdin 公共字段：conversationId、workspacePaths[]、transcriptPath、artifactDirectoryPath、modelName；
  PreToolUse 另有 toolCall {name, args}、stepIdx；PostToolUse 多一个可选 error。
  输出：{"decision": "allow|deny|ask|force_ask|deny_unless_prior_grant", "reason": "..."}；退出码语义
  文档没写，所以拒绝用 JSON + exit 0。
  工具名是 snake_case、入参是 PascalCase（run_command 的 CommandLine/Cwd、write_to_file 的
  TargetFile/CodeContent、view_file 的 AbsolutePath……），注册表里有映射。
"""
import json

from .. import registry
from . import base, claude

AGENT = "antigravity-cli"
BLOCK_EXIT_CODE = 0


def _common(data):
    roots = data.get("workspacePaths") or []
    cwd = roots[0] if roots and isinstance(roots[0], str) else (data.get("cwd") or "")
    return dict(session_id=data.get("conversationId") or data.get("session_id") or "",
                cwd=cwd, transcript_path=data.get("transcriptPath") or data.get("transcript_path"))


def parse(mode, data, agent=AGENT):
    common = _common(data)
    if mode in ("pre", "post"):
        tc = data.get("toolCall") or {}
        native_tool = tc.get("name") or data.get("tool_name") or ""
        native_input = tc.get("args") if isinstance(tc.get("args"), dict) else (data.get("tool_input") or {})
        c = base.call(agent, native_tool, native_input,
                      tool_response={"error": data["error"]} if data.get("error") else None)
        # run_command 自带的 Cwd（agy 默认是 ~/.gemini/antigravity-cli/scratch）留在 tool_input.cwd 里，
        # 事件的 cwd 仍用工作区根：会话的 cwd 要稳定，Web UI 靠它把会话和进程、目录对上；
        # 越界规则按工作区根算也更合理（scratch 目录本身就在项目外）。
        # multi_replace_file_content 的 ReplacementChunks 拼成一段 new_string，content 类规则才看得到
        chunks = c["tool_input"].get("ReplacementChunks")
        if isinstance(chunks, list):
            c["tool_input"]["new_string"] = "\n".join(
                str(ch.get("ReplacementContent", "")) for ch in chunks if isinstance(ch, dict))
        ev = base.event(agent, mode, data, calls=[c], **common)
        if data.get("stepIdx") is not None:
            ev["extra"]["step_idx"] = data["stepIdx"]
        if data.get("modelName"):
            ev["extra"]["model"] = data["modelName"]
        return ev
    if mode == "prompt":
        # PreInvocation 在每次模型调用前都触发（一轮对话里工具每跑一步就一次），没有 prompt 文本。
        # 真机实测：按 prompt 记会刷出一堆空的"提交"行。第 0 次当作会话开始记一条，之后不记。
        num = data.get("invocationNum")
        if num in (0, None):
            ev = base.event(agent, "session_start", data, extra={"source": "PreInvocation"}, **common)
            if data.get("modelName"):
                ev["extra"]["model"] = data["modelName"]
            return ev
        return base.event(agent, "noop", data, **common)
    ev = claude.parse(mode, data, agent=agent)
    ev.update(common)
    if data.get("modelName"):
        ev["extra"]["model"] = data["modelName"]
    return ev


def emit_pre(decision):
    if decision["decision"] == "blocked":
        return json.dumps({"decision": "deny", "reason": decision.get("reason") or "CC-Monitor blocked"}), BLOCK_EXIT_CODE
    if decision.get("handled_via_confirm"):
        return json.dumps({"decision": "allow"}), 0
    return None, 0


def emit_permission(behavior):
    return None


def hook_config_entries(hook_bin, agent, events):
    """返回的是 hooks.json 里 "cc-monitor" 这个 hook 名下面的内容；PreToolUse/PostToolUse 带 matcher
    分组，其它事件是扁平的命令列表。"""
    out = {"enabled": True}
    for native, mode in events.items():
        cmd = {"type": "command", "command": '"{}" {} --agent {}'.format(hook_bin, mode, agent), "timeout": 100}
        if native in ("PreToolUse", "PostToolUse"):
            out[native] = [{"matcher": "*", "hooks": [cmd]}]
        else:
            out[native] = [cmd]
    return out
