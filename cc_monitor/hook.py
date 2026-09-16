import json
import sys

from . import audit_state, notify, policy, rematch, storage


def read_hook_input():
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def handle_pre(data):
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {}) or {}
    session_id = data.get("session_id", "")
    cwd = data.get("cwd", "")
    transcript_path = data.get("transcript_path")

    state = audit_state.get_state()
    if state == "stopped":
        # 完全不介入：不判定、不记录，等价于没装这个 hook。
        sys.exit(0)

    rules = policy.load_rules()
    rule, matched_value = policy.evaluate(tool_name, tool_input, rules=rules, cwd=cwd)
    # 规则表跟上次重判历史事件时不一样了（用户改了 rules.json、或者升级带来了新默认
    # 规则）——后台起个进程用新规则把历史事件的 matched_rule 重算一遍，首页统计才准。
    rematch.maybe_schedule(rules)
    decision = "allowed"
    risk = "low"
    # 只有真的走过我们自己的 confirm 流程（一直允许的记忆，或者这次真的问过 tty/网页）
    # 才代表我们"接管"了这次询问——这种情况下才需要在 stdout 输出
    # hookSpecificOutput.permissionDecision=allow，让 Claude Code 跳过它自己原生的
    # "Do you want to proceed?" 弹窗（不然用户点了我们网页上的"允许"，终端里还得再按
    # 一次 y，等于白问）。没有规则匹配到、或者规则本来就是 log/block 的情况完全不touch
    # 这个字段——没被我们审查过的工具，Claude Code 自己的默认询问该弹还弹，不能因为
    # 我们的 hook 顺手就把安全网撤了。
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
                approved = notify.confirm(tool_name, rule, matched_value, session_id=session_id, cwd=cwd)
                decision = "allowed" if approved else "blocked"
                handled_via_confirm = approved
        elif action == "notify":
            # 不是"要不要允许"的问题（比如 AskUserQuestion 这种 Claude Code 自己在问
            # 用户问题的工具，压根没有 allow/deny 语义），只是把"现在有个事在等你"这个
            # 状态暴露到网页上——不阻塞、不弹 tty 确认框，Claude Code 该怎么原生交互
            # 还怎么交互，我们只是在旁边记一笔"这个终端正等着"，对应的 PostToolUse
            # 一来就自动标掉（见 handle_post 里的 resolve_pending_notify）。
            decision = "allowed"
            storage.create_pending_approval(
                session_id=session_id,
                tool_name=tool_name,
                cwd=cwd,
                matched_rule=rule["id"],
                matched_value=matched_value,
                risk=risk,
                kind="notify",
            )
        else:  # "log"
            decision = "allowed"

    storage.log_event(
        session_id=session_id,
        source="hook_pre",
        tool_name=tool_name,
        detail=tool_input,
        cwd=cwd,
        risk=risk,
        matched_rule=rule["id"] if rule else None,
        decision=decision,
        transcript_path=transcript_path,
    )

    if decision == "blocked":
        reason = "[CC-Monitor] 操作被拦截 (规则: {}): {}".format(rule["id"], matched_value)
        print(reason, file=sys.stderr)
        sys.exit(2)

    if handled_via_confirm:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "CC-Monitor: {} 已批准".format(rule["id"]),
            }
        }))
    sys.exit(0)


def handle_post(data):
    if audit_state.get_state() == "stopped":
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {}) or {}
    tool_response = data.get("tool_response", {})
    session_id = data.get("session_id", "")
    cwd = data.get("cwd", "")
    transcript_path = data.get("transcript_path")

    storage.log_event(
        session_id=session_id,
        source="hook_post",
        tool_name=tool_name,
        detail={"input": tool_input, "response": tool_response},
        cwd=cwd,
        risk="info",
        matched_rule=None,
        decision="completed",
        transcript_path=transcript_path,
    )
    # 工具调用真的跑完了——如果这个 (session, tool_name) 之前建过一条 kind='notify'
    # 的"等你处理"记录（比如 AskUserQuestion 的问题终于被回答了），标成已处理，
    # 不会一直挂在"AI 审批台"上。跟这个工具是不是命中了 notify 规则完全没关系，
    # 没有对应记录的话这里就是个no-op，不需要先查一遍是不是 notify 类工具。
    storage.resolve_pending_notify(session_id, tool_name, tool_response)
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


def handle_permission(data):
    """PermissionRequest 事件：Claude Code 自己的权限系统判定这次工具调用需要问人
    （马上要弹原生的 "Do you want to proceed?"）。PreToolUse 阶段我们没法知道它接下来
    会不会弹，所以光靠 confirm 规则镜像不到这些原生确认框——这个事件就是专门补这个
    缺口的：把询问同步到 Web UI 的"AI 审批台"，网页/终端给了答案就通过
    hookSpecificOutput.decision 替用户答掉；没人答（超时）或者用户主动交还，就静默
    退出（不输出任何 JSON），Claude Code 该弹原生框还弹——绝不会因为我们在场就把
    安全网撤了。文档明确 exit 2 对这个事件无效，拒绝只能走 decision.behavior=deny。
    """
    state = audit_state.get_state()
    if state in ("stopped", "paused"):
        # 停止：完全不介入。暂停：不真的拦截/弹确认，原生框自己弹。
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {}) or {}
    session_id = data.get("session_id", "")
    cwd = data.get("cwd", "")

    if storage.is_session_always_allowed(session_id, notify.permission_session_key(tool_name)):
        behavior = "allow"
    else:
        behavior = notify.permission_request(
            tool_name, summarize_tool_input(tool_input), session_id=session_id, cwd=cwd
        )
        if behavior is None:
            sys.exit(0)  # 交还 Claude Code 原生确认框

    # 按文档的字段形状：decision.message 只对 deny 有意义（告诉模型为什么被拒），allow
    # 不带任何多余字段。
    decision = {"behavior": behavior}
    if behavior == "deny":
        decision["message"] = "CC-Monitor: 用户在 AI 审批台拒绝了这次操作"
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": decision,
        }
    }))
    sys.exit(0)


# 下面这几个是 Claude Code 的会话生命周期 hook：跟 PreToolUse/PostToolUse（只在"调用
# 某个工具"时触发）不一样，这些事件不管这一轮有没有调用工具都会触发——纯审计留痕，
# 不判定、不拦截、不弹确认框（生命周期事件不是"允许/拒绝"语义，没有 action 概念）。
# 只在 state=="stopped"（完全停止审计）时才不介入，跟 handle_post 是同一个尺度：
# 暂停(paused) 状态下依然照常记录，只是 handle_pre 那边的 confirm/block 不会真的拦。


def handle_user_prompt_submit(data):
    """用户往对话框里敲回车提交的原始输入——这是唯一能看到"用户到底让 Claude 干了
    什么"的钩子。之前的审计日志全是工具调用层面的记录，纯聊天、没有触发任何工具调用
    的那些轮次完全没有留痕。这里只负责记录，不做规则匹配/拦截——用户对自己终端里
    打的字，没有"允许/拒绝"这回事。
    """
    if audit_state.get_state() == "stopped":
        sys.exit(0)
    storage.log_event(
        session_id=data.get("session_id", ""),
        source="hook_prompt",
        tool_name="UserPromptSubmit",
        detail={"prompt": data.get("prompt", "")},
        cwd=data.get("cwd", ""),
        risk="info",
        matched_rule=None,
        decision="submitted",
        transcript_path=data.get("transcript_path"),
    )
    sys.exit(0)


def handle_session_start(data):
    if audit_state.get_state() == "stopped":
        sys.exit(0)
    storage.log_event(
        session_id=data.get("session_id", ""),
        source="hook_lifecycle",
        tool_name="SessionStart",
        detail={"source": data.get("source", "")},
        cwd=data.get("cwd", ""),
        risk="info",
        matched_rule=None,
        decision="observed",
        transcript_path=data.get("transcript_path"),
    )
    sys.exit(0)


def handle_session_end(data):
    if audit_state.get_state() == "stopped":
        sys.exit(0)
    storage.log_event(
        session_id=data.get("session_id", ""),
        source="hook_lifecycle",
        tool_name="SessionEnd",
        detail={"reason": data.get("reason", "")},
        cwd=data.get("cwd", ""),
        risk="info",
        matched_rule=None,
        decision="observed",
        transcript_path=data.get("transcript_path"),
    )
    sys.exit(0)


def handle_pre_compact(data):
    if audit_state.get_state() == "stopped":
        sys.exit(0)
    storage.log_event(
        session_id=data.get("session_id", ""),
        source="hook_lifecycle",
        tool_name="PreCompact",
        detail={
            "trigger": data.get("trigger", ""),
            "custom_instructions": data.get("custom_instructions", ""),
        },
        cwd=data.get("cwd", ""),
        risk="info",
        matched_rule=None,
        decision="observed",
        transcript_path=data.get("transcript_path"),
    )
    sys.exit(0)


def handle_stop(data, subagent=False):
    if audit_state.get_state() == "stopped":
        sys.exit(0)
    storage.log_event(
        session_id=data.get("session_id", ""),
        source="hook_lifecycle",
        tool_name="SubagentStop" if subagent else "Stop",
        detail={"stop_hook_active": data.get("stop_hook_active", False)},
        cwd=data.get("cwd", ""),
        risk="info",
        matched_rule=None,
        decision="observed",
        transcript_path=data.get("transcript_path"),
    )
    sys.exit(0)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "pre"
    try:
        data = read_hook_input()
        if mode == "pre":
            handle_pre(data)
        elif mode == "post":
            handle_post(data)
        elif mode == "permission":
            handle_permission(data)
        elif mode == "prompt":
            handle_user_prompt_submit(data)
        elif mode == "session_start":
            handle_session_start(data)
        elif mode == "session_end":
            handle_session_end(data)
        elif mode == "precompact":
            handle_pre_compact(data)
        elif mode == "stop":
            handle_stop(data)
        elif mode == "subagent_stop":
            handle_stop(data, subagent=True)
        else:
            sys.exit(0)
    except SystemExit:
        raise
    except Exception as exc:  # fail open: never let a bug in the monitor brick Claude Code
        print("[CC-Monitor] hook 内部错误，已放行: {}".format(exc), file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
