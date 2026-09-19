"""应用层 hook 入口：`CC-Monitor-hook <mode> [--agent <id>]`。

三段式：适配器把某家 agent 的 hook stdin 翻译成规范事件（adapters/*.py）→ 这里做判定/审批/
记录（一份代码服务所有 agent）→ 适配器把判定结果翻译回那家 agent 认得的输出（stdout JSON /
退出码）。--agent 由 install.py 在注册 hook 命令时写死，不传就是 Claude Code——老安装的
settings.json 里的命令行不带这个参数，行为跟以前完全一样。
"""
import json
import os
import sys

from . import adapters, audit_state, notify, policy, procscan, registry, rematch, storage


def read_hook_input():
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def parse_args(argv):
    """argv[1] 是模式，其余只认 --agent <id> / --agent=<id>。多余的参数忽略，不报错——hook
    命令行是写在别人配置文件里的，宁可放行也不能因为参数不认识就把 agent 卡住。"""
    mode = "pre"
    # `CC-Monitor run --agent x -- <cmd>` 会给整棵进程树设 CC_MONITOR_AGENT；hook 命令行没写
    # --agent 时用它，这样自研 agent 只要按 Claude Code 协议调 hook 就能被正确归属。
    agent = os.environ.get("CC_MONITOR_AGENT") or registry.DEFAULT_AGENT
    rest = list(argv[1:])
    if rest and not rest[0].startswith("-"):
        mode = rest.pop(0)
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--agent" and i + 1 < len(rest):
            agent = rest[i + 1]
            i += 2
            continue
        if a.startswith("--agent="):
            agent = a.split("=", 1)[1]
        i += 1
    if registry.get(agent) is None and agent != "generic":
        agent = registry.DEFAULT_AGENT
    return mode, agent


# ---- 判定（agent 无关） ----

def decide_call(call, session_id, cwd, state, rules, agent):
    """对一条规范化的工具调用做规则判定 + 该问就问。返回 decision dict，并把事件记进库。"""
    tool_name = call["tool_name"]
    tool_input = call["tool_input"]
    rule, matched_value = policy.evaluate(tool_name, tool_input, rules=rules, cwd=cwd, agent=agent)
    decision = "allowed"
    risk = "low"
    # 只有真的走过我们自己的 confirm 流程（一直允许的记忆，或者这次真的问过 tty/网页）
    # 才代表我们"接管"了这次询问——这种情况下适配器才会输出"跳过原生确认"的 JSON。
    # 没有规则匹配到、或者规则本来就是 log/block 的情况完全不 touch——没被我们审查过的
    # 工具，agent 自己的默认询问该弹还弹，不能因为我们的 hook 顺手就把安全网撤了。
    handled_via_confirm = False

    if rule:
        risk = rule["risk"]
        action = rule["action"]
        if state == "paused":
            # 暂停：规则该怎么判还是怎么判、正常记下来，但从不真的拦截或弹确认框。
            decision = "allowed"
        elif action == "block":
            decision = "blocked"
        elif action == "confirm":
            # 之前这个 session 里对同一条规则点过"一直允许"，就不用再问一遍——
            # 这个记忆是按 session 记的，别的 session 跑一样的命令还是照常问。
            if storage.is_session_always_allowed(session_id, rule["id"]):
                decision = "allowed"
                handled_via_confirm = True
            else:
                approved = notify.confirm(tool_name, rule, matched_value, session_id=session_id, cwd=cwd, agent=agent)
                decision = "allowed" if approved else "blocked"
                handled_via_confirm = approved
        elif action == "notify":
            # 不是"要不要允许"的问题（比如 AskUserQuestion 这种 agent 自己在问用户问题的工具，
            # 压根没有 allow/deny 语义），只是把"现在有个事在等你"这个状态暴露到网页上——
            # 不阻塞、不弹 tty 确认框，对应的 PostToolUse 一来就自动标掉。
            decision = "allowed"
            storage.create_pending_approval(
                session_id=session_id, tool_name=tool_name, cwd=cwd, matched_rule=rule["id"],
                matched_value=matched_value, risk=risk, kind="notify", agent=agent,
            )
        else:  # "log"
            decision = "allowed"

    detail = dict(tool_input)
    if call.get("native_tool") and call["native_tool"] != tool_name:
        detail["native_tool"] = call["native_tool"]
        detail["native_input"] = call.get("native_input")
    return {
        "decision": decision,
        "risk": risk,
        "rule": rule,
        "rule_id": rule["id"] if rule else None,
        "matched_value": matched_value,
        "handled_via_confirm": handled_via_confirm,
        "reason": "[CC-Monitor] 操作被拦截 (规则: {}): {}".format(rule["id"], matched_value) if decision == "blocked" else None,
        "detail": detail,
    }


def handle_pre(ev, adapter):
    state = audit_state.get_state()
    if state == "stopped":
        # 完全不介入：不判定、不记录，等价于没装这个 hook。
        sys.exit(0)

    rules = policy.load_rules()
    # 规则表跟上次重判历史事件时不一样了（用户改了 rules.json、或者升级带来了新默认
    # 规则）——后台起个进程用新规则把历史事件的 matched_rule 重算一遍，首页统计才准。
    rematch.maybe_schedule(rules)

    agent = ev["agent"]
    session_id = ev["session_id"]
    cwd = ev["cwd"]
    results = []
    for call in ev["calls"]:
        r = decide_call(call, session_id, cwd, state, rules, agent)
        results.append((call, r))
        storage.log_event(
            session_id=session_id, source="hook_pre", tool_name=call["tool_name"], detail=r["detail"],
            cwd=cwd, risk=r["risk"], matched_rule=r["rule_id"], decision=r["decision"],
            transcript_path=ev["transcript_path"], agent=agent, native_tool=call.get("native_tool"),
        )
        if r["decision"] == "blocked":
            break  # 一次调用（比如 apply_patch）里有一个文件被拦，整个调用就拦，后面的不用再问

    # 汇总：任何一条 blocked 就是 blocked；否则只要有一条是我们问过的，就算接管了。
    blocked = next((r for _, r in results if r["decision"] == "blocked"), None)
    final = {
        "decision": "blocked" if blocked else "allowed",
        "handled_via_confirm": (not blocked) and any(r["handled_via_confirm"] for _, r in results),
        "reason": blocked["reason"] if blocked else None,
        "rule_id": (blocked or (results[-1][1] if results else {})).get("rule_id"),
    }
    if blocked:
        print(final["reason"], file=sys.stderr)
    out, code = adapter.emit_pre(final)
    if out:
        print(out)
    sys.exit(code)


def handle_post(ev, adapter):
    state = audit_state.get_state()
    if state == "stopped":
        sys.exit(0)
    agent = ev["agent"]
    evaluate = ev["extra"].get("evaluate_in_post")
    rules = policy.load_rules() if evaluate else None
    for call in ev["calls"]:
        risk, rule_id, decision = "info", None, "completed"
        if evaluate:
            # 有些 agent（Cursor 的 afterFileEdit）只在事后告诉我们改了哪个文件——拦不住了，
            # 但规则和越界检测照样跑一遍，结果记成 observed，首页统计和越界卡片才看得到。
            rule, _ = policy.evaluate(call["tool_name"], call["tool_input"], rules=rules, cwd=ev["cwd"], agent=agent)
            if rule:
                risk, rule_id, decision = rule["risk"], rule["id"], "observed"
        storage.log_event(
            session_id=ev["session_id"], source="hook_post", tool_name=call["tool_name"],
            detail={"input": call["tool_input"], "response": call.get("tool_response"),
                    **({"native_tool": call["native_tool"]} if call.get("native_tool") != call["tool_name"] else {})},
            cwd=ev["cwd"], risk=risk, matched_rule=rule_id, decision=decision,
            transcript_path=ev["transcript_path"], agent=agent, native_tool=call.get("native_tool"),
        )
        # 工具调用真的跑完了——如果这个 (session, tool_name) 之前建过一条 kind='notify'
        # 的"等你处理"记录（比如 AskUserQuestion 的问题终于被回答了），标成已处理。
        storage.resolve_pending_notify(ev["session_id"], call["tool_name"], call.get("tool_response"))
    sys.exit(0)


# PermissionRequest 的 tool_input 里挑一个最能代表"这次要干什么"的字段拿去网页上
# 展示：Bash 看 command，文件类工具看路径，抓网页看 url……都没有就整个 tool_input
# 原样 JSON。跟 policy.FIELD_CANDIDATES 是两回事——那边是规则匹配用的，这边只管展示。
PERMISSION_SUMMARY_FIELDS = ("command", "file_path", "path", "notebook_path", "url", "query", "pattern", "prompt")


def summarize_tool_input(tool_input):
    for key in PERMISSION_SUMMARY_FIELDS:
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return value
    try:
        return json.dumps(tool_input, ensure_ascii=False)[:2000]
    except (TypeError, ValueError):
        return str(tool_input)[:2000]


def handle_permission(ev, adapter):
    """PermissionRequest 事件：agent 自己的权限系统判定这次工具调用需要问人（马上要弹原生的
    "Do you want to proceed?"）。PreToolUse 阶段我们没法知道它接下来会不会弹，所以光靠
    confirm 规则镜像不到这些原生确认框——这个事件就是专门补这个缺口的：把询问同步到 Web UI
    的"AI 审批台"，网页/终端给了答案就替用户答掉；没人答（超时）或者用户主动交还，就静默
    退出（不输出任何 JSON），agent 该弹原生框还弹——绝不会因为我们在场就把安全网撤了。
    Claude Code 文档明确 exit 2 对这个事件无效，拒绝只能走 decision.behavior=deny。
    """
    state = audit_state.get_state()
    if state in ("stopped", "paused"):
        sys.exit(0)
    if not ev["calls"]:
        sys.exit(0)
    call = ev["calls"][0]
    tool_name = call["tool_name"]
    session_id = ev["session_id"]

    if storage.is_session_always_allowed(session_id, notify.permission_session_key(tool_name)):
        behavior = "allow"
    else:
        behavior = notify.permission_request(
            tool_name, summarize_tool_input(call["tool_input"]), session_id=session_id, cwd=ev["cwd"], agent=ev["agent"],
        )
        if behavior is None:
            sys.exit(0)  # 交还 agent 原生确认框
    out = adapter.emit_permission(behavior)
    if out:
        print(out)
    sys.exit(0)


# 下面这几个是会话生命周期 hook：跟 PreToolUse/PostToolUse（只在"调用某个工具"时触发）
# 不一样，这些事件不管这一轮有没有调用工具都会触发——纯审计留痕，不判定、不拦截、不弹
# 确认框。只在 state=="stopped" 时才不介入：暂停(paused) 状态下依然照常记录。

LIFECYCLE_TOOL_NAMES = {
    "session_start": "SessionStart", "session_end": "SessionEnd", "precompact": "PreCompact",
    "stop": "Stop", "subagent_stop": "SubagentStop",
}


def handle_prompt(ev, adapter):
    """用户往对话框里敲回车提交的原始输入——这是唯一能看到"用户到底让 agent 干了什么"
    的钩子。只负责记录，不做规则匹配/拦截——用户对自己终端里打的字，没有"允许/拒绝"这回事。"""
    if audit_state.get_state() == "stopped":
        sys.exit(0)
    storage.log_event(
        session_id=ev["session_id"], source="hook_prompt", tool_name="UserPromptSubmit",
        detail={"prompt": ev.get("prompt") or ""}, cwd=ev["cwd"], risk="info", matched_rule=None,
        decision="submitted", transcript_path=ev["transcript_path"], agent=ev["agent"],
    )
    sys.exit(0)


def handle_lifecycle(ev, adapter):
    if audit_state.get_state() == "stopped":
        sys.exit(0)
    storage.log_event(
        session_id=ev["session_id"], source="hook_lifecycle", tool_name=LIFECYCLE_TOOL_NAMES[ev["mode"]],
        detail=ev["extra"], cwd=ev["cwd"], risk="info", matched_rule=None, decision="observed",
        transcript_path=ev["transcript_path"], agent=ev["agent"],
    )
    sys.exit(0)


def handle_noop(ev, adapter):
    """适配器说这个事件不值得记（比如 Antigravity 每一步都触发的 PreInvocation）。"""
    sys.exit(0)


HANDLERS = {
    "noop": handle_noop,
    "pre": handle_pre, "post": handle_post, "permission": handle_permission, "prompt": handle_prompt,
    "session_start": handle_lifecycle, "session_end": handle_lifecycle, "precompact": handle_lifecycle,
    "stop": handle_lifecycle, "subagent_stop": handle_lifecycle,
}


def record_session(ev):
    """把"这个会话 ↔ 哪个 agent 根进程"记进 sessions 表。hook 进程是 agent 派生的，沿父进程链往上
    第一个认得出的 agent 进程就是根（Claude Code：hook ← sh ← claude）。探针拿 root_pid 反查，
    系统层事件就能带上 session_id；Web UI 用 root_pid 是否还活着判断会话生死，比按 cwd 猜准。
    任何一步出错都不影响主流程。"""
    if not ev.get("session_id") or audit_state.get_state() == "stopped":
        return
    try:
        root_pid, root_start, found_agent = procscan.find_agent_ancestor(os.getppid())
        if found_agent and found_agent != ev["agent"] and ev["agent"] != registry.DEFAULT_AGENT:
            # 命令行说是 codex、父链上认出来的却是别家——以命令行为准，但根 pid 仍然可信
            pass
        # 有些 agent 的 transcript 里没有模型名（Antigravity），但 hook stdin 带（modelName）——记进
        # sessions.model，Web UI 在 transcript 里找不到模型时用它。
        storage.touch_session(ev["agent"], ev["session_id"], root_pid=root_pid, root_start=root_start,
                              cwd=ev.get("cwd"), transcript_path=ev.get("transcript_path"),
                              model=(ev.get("extra") or {}).get("model"))
    except Exception:
        pass


def main():
    mode, agent = parse_args(sys.argv)
    try:
        handler = HANDLERS.get(mode)
        if handler is None:
            sys.exit(0)
        data = read_hook_input()
        adapter = adapters.for_agent(agent)
        ev = adapter.parse(mode, data, agent=agent)
        if ev.get("mode", mode) != "noop":
            record_session(ev)
        # 适配器可能把模式改掉（Cursor 的 beforeSubmitPrompt 不管挂在哪个事件下都是 prompt）
        HANDLERS.get(ev.get("mode", mode), handler)(ev, adapter)
    except SystemExit:
        raise
    except Exception as exc:  # fail open: never let a bug in the monitor brick the agent
        print("[CC-Monitor] hook 内部错误，已放行: {}".format(exc), file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
