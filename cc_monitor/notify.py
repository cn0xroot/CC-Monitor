import platform
import select
import subprocess


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


def confirm(tool_name, rule, matched_value, timeout=20):
    """Ask the user in the controlling terminal whether to allow the action.

    Returns True (allow) / False (deny). Fails closed (deny) if no tty is
    available or the user does not answer within `timeout` seconds.
    """
    desktop_notify("CC-Monitor 需要确认", "{}: {}".format(tool_name, matched_value[:80]))
    try:
        with open("/dev/tty", "r+") as tty:
            tty.write(
                "\n[CC-Monitor] 检测到中风险操作 (规则: {})\n"
                "工具: {}\n匹配内容: {}\n"
                "是否允许? [y/N] (等待 {}s 后默认拒绝): ".format(
                    rule["id"], tool_name, matched_value, timeout
                )
            )
            tty.flush()
            ready, _, _ = select.select([tty], [], [], timeout)
            if not ready:
                tty.write("\n[CC-Monitor] 超时，默认拒绝\n")
                return False
            answer = tty.readline().strip().lower()
            return answer == "y"
    except OSError:
        # No controlling tty (e.g. headless/CI) -> fail closed.
        return False
