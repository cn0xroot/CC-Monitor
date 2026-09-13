import platform
import select
import subprocess
import time

from . import storage


def desktop_notify(title, message):
    system = platform.system()
    try:
        if system == "Linux":
            subprocess.run(
                ["notify-send", title, message],
                check=False,
                timeout=2,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        elif system == "Darwin":
            script = 'display notification "{}" with title "{}"'.format(
                message.replace('"', "'"), title.replace('"', "'")
            )
            subprocess.run(
                ["osascript", "-e", script],
                check=False,
                timeout=2,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        pass


def confirm(tool_name, rule, matched_value, session_id=None, cwd=None, timeout=90):
    """询问是否允许这次操作——终端 tty 和 Web UI 的"待批准"页面两条路同时等着，
    哪边先给出答案就用哪边的。没有 tty（无头环境）完全不影响 Web UI 这条路。

    超时比以前的纯 tty 版本（20s）长很多：人要先看到桌面通知/网页提示、点开
    网页、找到这条、点按钮，比直接在当前终端敲 y 慢得多，20s 对着网页这条路
    基本不够用。

    返回 True（允许，包括"允许一次"和"一直允许该 session"两种）或 False（拒绝/超时）。
    "一直允许"会在这里顺带把 session_id+matched_rule 记进 session_always_allow，
    调用方（hook.py）不用另外处理。
    """
    desktop_notify("CC-Monitor 需要确认", "{}: {}".format(tool_name, matched_value[:80]))
    approval_id = storage.create_pending_approval(
        session_id=session_id,
        tool_name=tool_name,
        cwd=cwd,
        matched_rule=rule["id"],
        matched_value=matched_value,
        risk=rule["risk"],
    )

    tty = None
    try:
        tty = open("/dev/tty", "r+")
        tty.write(
            "\n[CC-Monitor] 检测到中风险操作 (规则: {})\n"
            "工具: {}\n匹配内容: {}\n"
            "是否允许? [y/N]（也可以去 Web UI 的“待批准”页面处理，等待 {}s 后默认拒绝）: ".format(
                rule["id"], tool_name, matched_value, timeout
            )
        )
        tty.flush()
    except OSError:
        tty = None  # 没有控制终端（无头/CI）不要紧，Web UI 那条路照样能用

    deadline = time.time() + timeout
    result_status = None
    try:
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            wait_slice = min(1.0, remaining)
            if tty is not None:
                ready, _, _ = select.select([tty], [], [], wait_slice)
                if ready:
                    answer = tty.readline().strip().lower()
                    storage.resolve_approval(approval_id, "allowed" if answer == "y" else "denied", "tty")
            else:
                time.sleep(wait_slice)
            # 不管刚才是不是自己这一轮写进去的，都重新读一遍最终状态——
            # tty 和网页可能几乎同时点/敲，只认数据库里实际落地的结果。
            status = storage.poll_approval_status(approval_id)
            if status and status != "pending":
                result_status = status
                break
    finally:
        if tty is not None:
            if result_status is None:
                try:
                    tty.write("\n[CC-Monitor] 超时，默认拒绝\n")
                except OSError:
                    pass
            tty.close()

    if result_status is None:
        storage.resolve_approval(approval_id, "expired", "timeout")
        result_status = "expired"

    # allowed_10m/allowed_30m 跟"一直允许"走的是同一张 session_always_allow 表，
    # 区别只是多带一个 expires_at——到点之后 is_session_always_allowed() 就不再认它。
    TIMED_ALLOW_MINUTES = {"allowed_10m": 10, "allowed_30m": 30}
    if result_status in ("always_allowed",) + tuple(TIMED_ALLOW_MINUTES) and session_id:
        minutes = TIMED_ALLOW_MINUTES.get(result_status)
        expires_at = (
            time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(time.time() + minutes * 60))
            if minutes
            else None
        )
        storage.add_session_always_allow(session_id, rule["id"], expires_at=expires_at)

    return result_status in ("allowed", "always_allowed") + tuple(TIMED_ALLOW_MINUTES)
