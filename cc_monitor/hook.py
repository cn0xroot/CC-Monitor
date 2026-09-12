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

    if rule:
        risk = rule["risk"]
        action = rule["action"]
        if state == "paused":
            # 暂停：规则该怎么判还是怎么判、正常记下来，但从不真的拦截或弹确认框。
            decision = "allowed"
        elif action == "block":
            decision = "blocked"
        elif action == "confirm":
            decision = "allowed" if notify.confirm(tool_name, rule, matched_value) else "blocked"
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
