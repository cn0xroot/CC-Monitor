import os
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


TIMED_ALLOW_MINUTES = {"allowed_10m": 10, "allowed_30m": 30}
ALLOW_STATUSES = ("allowed", "always_allowed") + tuple(TIMED_ALLOW_MINUTES)


def _open_tty():
    """打开控制终端；没有（无头/CI）就返回 None，Web UI 那条路照样能用。

    必须用无缓冲的二进制模式：文本模式的 "r+" 会套一层 BufferedRandom，构造时要求
    底层 seekable——Linux 上对 tty 做 lseek 会返回 0（"成功"），macOS 上返回
    ESPIPE，于是 open() 直接抛 io.UnsupportedOperation（OSError 的子类），被
    except 吞掉后 tty 永远是 None：Mac 用户在终端里永远看不到提示、也没法敲
    y/N，只剩网页一条路。buffering=0 拿到的是裸 FileIO，不检查 seekable。
    """
    try:
        return open("/dev/tty", "r+b", buffering=0)
    except OSError:
        return None


def _tty_write(tty, text):
    try:
        tty.write(text.encode("utf-8", "replace"))
    except OSError:
        pass


def _wait_for_decision(approval_id, tty, timeout, parse_answer, timeout_note):
    """终端 tty 和 Web UI 的"待批准"页面两条路同时等着，哪边先给出答案就用哪边的。

    parse_answer(answer_text) -> status 或 None：把终端里敲的内容翻译成
    pending_approvals.status；返回 None 表示这次输入不算数、继续等。
    返回最终落地的 status；超时返回 "expired"（已经写进数据库）。
    """
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
                    # 不用 readline()：Claude Code 的 TUI 让终端处于 raw 模式，回车发过来的
                    # 是 "\r" 而不是 "\n"，readline 会一直等那个永远不来的换行，把整个
                    # 轮询循环（包括网页那条路）卡死。直接把当前能读到的字节拿出来，看首
                    # 字符：cooked 模式下 select 要等到回车才就绪，读到 "y\n"；raw 模式下
                    # 敲 y 立刻就绪，读到 "y"——两种情况判断方式一样。
                    answer = os.read(tty.fileno(), 64).decode("utf-8", "replace").strip().lower()
                    status = parse_answer(answer)
                    if status:
                        storage.resolve_approval(approval_id, status, "tty")
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
                _tty_write(tty, "\n[CC-Monitor] " + timeout_note + "\n")
            tty.close()

    if result_status is None:
        storage.resolve_approval(approval_id, "expired", "timeout")
        result_status = "expired"
    return result_status


def _remember_session_allow(result_status, session_id, key):
    # allowed_10m/allowed_30m 跟"一直允许"走的是同一张 session_always_allow 表，
    # 区别只是多带一个 expires_at——到点之后 is_session_always_allowed() 就不再认它。
    if result_status in ("always_allowed",) + tuple(TIMED_ALLOW_MINUTES) and session_id:
        minutes = TIMED_ALLOW_MINUTES.get(result_status)
        expires_at = (
            time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(time.time() + minutes * 60))
            if minutes
            else None
        )
        storage.add_session_always_allow(session_id, key, expires_at=expires_at)


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
    # 规则的 title/desc（default_rules.json 里每条都有）：告诉人"这是要确认什么操作"，
    # 光给一个 git_force_push 这样的 id 大多数人看不懂。用户自己加的规则没写就退回 id。
    title = rule.get("title") or rule["id"]
    desc = rule.get("desc") or ""
    desktop_notify("CC-Monitor 需要确认：{}".format(title), "{}: {}".format(tool_name, matched_value[:80]))
    approval_id = storage.create_pending_approval(
        session_id=session_id,
        tool_name=tool_name,
        cwd=cwd,
        matched_rule=rule["id"],
        matched_value=matched_value,
        risk=rule["risk"],
    )

    tty = _open_tty()
    if tty is not None:
        _tty_write(
            tty,
            "\n[CC-Monitor] 需要确认：{title}\n"
            "{desc}"
            "规则: {rule} · 风险: {risk} · 工具: {tool}\n匹配内容: {value}\n"
            "是否允许? [y/N]（也可以去 Web UI 的“AI 审批台”处理，等待 {timeout}s 后默认拒绝）: ".format(
                title=title,
                desc=("说明: " + desc + "\n") if desc else "",
                rule=rule["id"],
                risk=rule.get("risk", "-"),
                tool=tool_name,
                value=matched_value,
                timeout=timeout,
            ),
        )

    result_status = _wait_for_decision(
        approval_id,
        tty,
        timeout,
        parse_answer=lambda answer: "allowed" if answer[:1] == "y" else "denied",
        timeout_note="超时，默认拒绝",
    )
    _remember_session_allow(result_status, session_id, rule["id"])
    return result_status in ALLOW_STATUSES


def permission_session_key(tool_name):
    """PermissionRequest 这条路没有规则 id，"一直允许"按工具名记（同一个 session 里
    这个工具后续的原生询问都直接放行）——跟 Claude Code 自己那个"don't ask again"
    粒度差不多，都是 session 级别。"""
    return "permission:" + tool_name


def permission_request(tool_name, matched_value, session_id=None, cwd=None, timeout=90):
    """Claude Code 自己准备弹原生"Do you want to proceed?"确认框（PermissionRequest
    hook 事件）——把它同步到 Web UI 的"AI 审批台"上，网页点了就替用户答掉。

    跟 confirm() 的区别：这不是我们的规则判定出来的，是 Claude Code 自己的权限系统
    要问；所以"没人答"的兜底不是拒绝，而是把这次询问原样交还给 Claude Code 的原生
    确认框（hook 静默退出，Claude Code 该弹还弹）。终端里敲 y/n 直接答，敲回车/
    其它键立刻交还原生框（人就在终端前，用原生框选项更多）。

    返回 "allow" / "deny" / None（None = 交还原生确认框）。
    """
    desktop_notify("CC-Monitor：Claude 请求权限", "{}: {}".format(tool_name, matched_value[:80]))
    approval_id = storage.create_pending_approval(
        session_id=session_id,
        tool_name=tool_name,
        cwd=cwd,
        matched_rule=permission_session_key(tool_name),
        matched_value=matched_value,
        risk="low",
        kind="permission",
    )

    tty = _open_tty()
    if tty is not None:
        _tty_write(
            tty,
            "\n[CC-Monitor] Claude Code 请求权限\n"
            "工具: {}\n内容: {}\n"
            "是否允许? [y/n]（也可以去 Web UI 的“AI 审批台”处理；敲回车或等待 {}s 后转回 Claude Code 原生确认框）: ".format(
                tool_name, matched_value, timeout
            ),
        )

    def parse_answer(answer):
        if answer[:1] == "y":
            return "allowed"
        if answer[:1] == "n":
            return "denied"
        return "deferred"

    result_status = _wait_for_decision(
        approval_id, tty, timeout, parse_answer=parse_answer, timeout_note="超时，转回 Claude Code 原生确认框"
    )
    _remember_session_allow(result_status, session_id, permission_session_key(tool_name))
    if result_status in ALLOW_STATUSES:
        return "allow"
    if result_status == "denied":
        return "deny"
    return None
