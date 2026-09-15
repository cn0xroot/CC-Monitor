"""把 hook 采集到的原始 tool_input/tool_response 翻译成人类可读的事件描述。"""
import re

from . import colors as col

MAX_SUMMARY_LEN = 240
MAX_OUTPUT_LEN = 300

TOOL_LABELS = {
    "Bash": "执行 Shell 命令",
    "Write": "写入文件",
    "Edit": "编辑文件",
    "MultiEdit": "批量编辑文件",
    "NotebookEdit": "编辑 Notebook",
    "Read": "读取文件",
    "Glob": "查找文件",
    "Grep": "搜索文件内容",
    "WebFetch": "抓取网页",
    "WebSearch": "网络搜索",
    "Task": "启动子代理",
    "Agent": "启动子代理",
    "TodoWrite": "更新任务列表",
    "UserPromptSubmit": "用户提交提示词",
    "SessionStart": "会话开始",
    "SessionEnd": "会话结束",
    "PreCompact": "上下文压缩前",
    "Stop": "主任务结束",
    "SubagentStop": "子代理结束",
}

STAGE_LABELS = {
    "hook_pre": "准备执行",
    "hook_post": "执行完成",
    "hook_prompt": "用户输入",
    "hook_lifecycle": "生命周期",
    "os_exec": "内核观测",
    "os_net": "内核观测",
}


def _collapse(text, limit=MAX_SUMMARY_LEN):
    if text is None:
        return ""
    text = str(text).replace("\r\n", " ⏎ ").replace("\n", " ⏎ ")
    if len(text) > limit:
        return text[:limit] + "...(共{}字符，已截断)".format(len(text))
    return text


# Bash 命令简易语法高亮：命令名/参数/字符串/变量/管道重定向符号分别上色。
# 不追求完整的 shell 语法解析，够在终端日志里一眼分清结构就行。
_SHELL_TOKEN_RE = re.compile(
    r"(?P<comment>#[^⏎]*)"
    r"|(?P<dstring>\"(?:[^\"\\]|\\.)*\")"
    r"|(?P<sstring>'[^']*')"
    r"|(?P<var>\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@#?*!$-])"
    r"|(?P<op>\|\||&&|;;|>>|<<|[|;&<>])"
    r"|(?P<flag>(?<!\S)--?[A-Za-z][\w-]*)"
    r"|(?P<glyph>⏎)"
    r"|(?P<word>[^\s|;&<>$'\"#]+)"
    r"|(?P<space>\s+)"
    r"|(?P<other>.)"  # 兜底：任何没被上面覆盖的单字符（比如落单的 $ / # / 引号），保证不丢字符
)


def _highlight_bash(text):
    if not col.ENABLED or not text:
        return text
    out = []
    expect_command = True
    for m in _SHELL_TOKEN_RE.finditer(text):
        kind = m.lastgroup
        tok = m.group()
        if kind == "comment":
            out.append(col.c(tok, dim=True))
        elif kind in ("dstring", "sstring"):
            out.append(col.c(tok, color="green"))
        elif kind == "var":
            out.append(col.c(tok, color="yellow"))
        elif kind == "op":
            out.append(col.c(tok, color="magenta", bold=True))
            expect_command = True
        elif kind == "flag":
            out.append(col.c(tok, color="cyan"))
        elif kind == "glyph":
            out.append(col.c(tok, dim=True))
        elif kind == "word":
            if expect_command:
                out.append(col.c(tok, color="blue", bold=True))
                expect_command = False
            else:
                out.append(tok)
        else:  # space
            out.append(tok)
    return "".join(out)


# 命令输出/日志的简易高亮：不追求解析具体格式，只挑最有信号的东西上色——
# 报错/异常关键字、警告关键字、成功关键字、文件路径。
_LOG_TOKEN_RE = re.compile(
    r"(?P<error>\b(?:error|exception|traceback|fatal|failed?|panic|denied|refused)\b|错误|异常|失败|拒绝)"
    r"|(?P<warn>\b(?:warn(?:ing)?|deprecated)\b|警告)"
    r"|(?P<ok>\b(?:success(?:ful)?|passed|done|ok)\b|成功|完成)"
    r"|(?P<path>(?:(?<=\s)|^)/[\w./-]+|\b[\w.-]+\.(?:py|js|ts|json|sh|log|txt|md|yaml|yml|c|cpp|h|go|rs)\b)"
    r"|(?P<glyph>⏎)",
    re.IGNORECASE,
)


def _highlight_log(text):
    if not col.ENABLED or not text:
        return text
    out = []
    pos = 0
    for m in _LOG_TOKEN_RE.finditer(text):
        out.append(text[pos:m.start()])
        kind = m.lastgroup
        tok = m.group()
        if kind == "error":
            out.append(col.c(tok, color="bright_red", bold=True))
        elif kind == "warn":
            out.append(col.c(tok, color="yellow"))
        elif kind == "ok":
            out.append(col.c(tok, color="green"))
        elif kind == "path":
            out.append(col.c(tok, color="cyan"))
        elif kind == "glyph":
            out.append(col.c(tok, dim=True))
        pos = m.end()
    out.append(text[pos:])
    return "".join(out)


def split_detail(source, detail):
    """PreToolUse 的 detail 就是 tool_input 本身；PostToolUse 的 detail 是 {input, response}。"""
    detail = detail or {}
    if source == "hook_post":
        return detail.get("input", {}) or {}, detail.get("response")
    return detail, None


def stage_label(source):
    return STAGE_LABELS.get(source, source or "-")


def _describe_os_exec(comm, detail):
    detail = detail or {}
    label = "系统层观测: 进程执行 ({})".format(comm)
    summary = _highlight_bash(_collapse(detail.get("argv", "")))
    extra = []
    if detail.get("shell_command"):
        if detail.get("hook_matched") is False:
            extra.append("⚠ 未匹配到对应的 hook 记录，可能绕过了监测")
        elif detail.get("hook_matched") is True:
            extra.append("✓ 与 hook 记录吻合")
    return label, summary, extra


def _describe_os_net(comm, detail):
    detail = detail or {}
    ip = detail.get("ip", "")
    port = detail.get("port", "")
    host = detail.get("host")
    summary = "{}:{}".format(ip, port) + (" ({})".format(host) if host else "")
    return "系统层观测: 网络连接 ({})".format(comm), summary, []


def describe(tool_name, source, detail):
    """返回 (事件类型标签, 一行摘要, 附加信息行列表)。"""
    if source == "os_exec":
        return _describe_os_exec(tool_name, detail)
    if source == "os_net":
        return _describe_os_net(tool_name, detail)

    tool_input, response = split_detail(source, detail)
    label = TOOL_LABELS.get(tool_name, tool_name or "未知操作")
    summary = ""
    extra = []

    if tool_name == "Bash":
        summary = _highlight_bash(_collapse(tool_input.get("command", "")))
        if response is not None:
            stderr = (response.get("stderr") or "").strip()
            interrupted = bool(response.get("interrupted"))
            ok = not interrupted and not stderr
            result_text = "成功" if ok else "失败/有错误输出"
            extra.append("结果: {}".format(col.c(result_text, color="green" if ok else "bright_red", bold=not ok)))
            tail_src = (response.get("stdout") or "").strip() or stderr
            if tail_src:
                extra.append("输出: {}".format(_highlight_log(_collapse(tail_src[-MAX_OUTPUT_LEN:]))))

    elif tool_name in ("Write", "NotebookEdit"):
        path = tool_input.get("file_path") or tool_input.get("notebook_path", "")
        content = tool_input.get("content") or tool_input.get("new_source", "")
        summary = "{} ({} 字节)".format(path, len(str(content)))

    elif tool_name in ("Edit", "MultiEdit"):
        path = tool_input.get("file_path", "")
        old = tool_input.get("old_string", "")
        new = tool_input.get("new_string", "")
        summary = "{} (-{} / +{} 字符)".format(path, len(old), len(new))

    elif tool_name == "Read":
        summary = tool_input.get("file_path", "")

    elif tool_name in ("Glob", "Grep"):
        pattern = tool_input.get("pattern", "")
        path = tool_input.get("path")
        summary = pattern + ("  (路径: {})".format(path) if path else "")

    elif tool_name == "WebFetch":
        summary = tool_input.get("url", "")

    elif tool_name == "WebSearch":
        summary = tool_input.get("query", "")

    elif tool_name in ("Task", "Agent"):
        summary = tool_input.get("description") or tool_input.get("prompt", "")
        summary = _collapse(summary)

    elif tool_name == "UserPromptSubmit":
        summary = _collapse(tool_input.get("prompt", ""))

    elif tool_name in ("SessionStart", "SessionEnd", "PreCompact"):
        summary = tool_input.get("source") or tool_input.get("reason") or tool_input.get("trigger") or "-"
        if tool_name == "PreCompact" and tool_input.get("custom_instructions"):
            extra.append("自定义压缩指令: {}".format(_collapse(tool_input["custom_instructions"])))

    elif tool_name in ("Stop", "SubagentStop"):
        summary = "stop_hook_active: {}".format("true" if tool_input.get("stop_hook_active") else "false")

    else:
        for key, value in tool_input.items():
            if value:
                summary = "{}={}".format(key, _collapse(value))
                break

    return label, summary, extra
