"""应用层 hook 适配器：把各家 agent 的 hook 协议翻译成同一种"规范事件"，再把我们的判定
结果翻译回各家认得的输出格式。判定逻辑本身（规则、审批、记录）在 hook.py 里，一份代码
服务所有 agent。

规范事件（parse() 的返回值）：
    {
      "agent": "codex",
      "mode": "pre" | "post" | "permission" | "prompt" | "session_start" | "session_end"
              | "precompact" | "stop" | "subagent_stop",
      "session_id": str, "cwd": str, "transcript_path": str|None,
      "calls": [ {"tool_name": <Claude 词汇>, "tool_input": <规范字段>,
                  "native_tool": <原名>, "native_input": <原入参>,
                  "tool_response": ...} ],   # pre/post/permission 用；一次 apply_patch 会拆成多条
      "prompt": str,                          # prompt 模式用
      "extra": {...}                          # 生命周期事件的附加字段
    }

emit_pre(decision) 返回 (stdout_text_or_None, exit_code)；decision 是 hook.py 产出的
    {"decision": "allowed"|"blocked", "handled_via_confirm": bool, "reason": str, "rule_id": str|None}
emit_permission(behavior) 返回 stdout_text_or_None；behavior 是 "allow" / "deny"。
"""
import importlib

from .. import registry

_PROTOCOLS = {}  # 已知协议：claude / codex / gemini / cursor / opencode / zcode


def for_agent(agent_id):
    """按 agent id 取适配器模块（按注册表里的 hooks.protocol 选）；不认识的 agent 退回 Claude
    协议——各家 hook 的 stdin 大同小异，退回去至少能记录，不会因为配置错了就什么都不记。"""
    spec = registry.get(agent_id)
    protocol = ((spec or {}).get("hooks") or {}).get("protocol") or "claude"
    return for_protocol(protocol)


def for_protocol(protocol):
    if protocol not in _PROTOCOLS:
        try:
            _PROTOCOLS[protocol] = importlib.import_module("cc_monitor.adapters." + protocol)
        except ImportError:
            _PROTOCOLS[protocol] = importlib.import_module("cc_monitor.adapters.claude")
    return _PROTOCOLS[protocol]
