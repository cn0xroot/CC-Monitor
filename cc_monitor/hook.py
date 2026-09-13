import json
import sys

from . import audit_state, notify, policy, storage


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

    rule, matched_value = policy.evaluate(tool_name, tool_input)
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


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "pre"
    try:
        data = read_hook_input()
        if mode == "pre":
            handle_pre(data)
        elif mode == "post":
            handle_post(data)
        else:
            sys.exit(0)
    except SystemExit:
        raise
    except Exception as exc:  # fail open: never let a bug in the monitor brick Claude Code
        print("[CC-Monitor] hook 内部错误，已放行: {}".format(exc), file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
