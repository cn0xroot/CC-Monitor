"""终端 ANSI 配色，只在真终端里生效；重定向到文件或设了 NO_COLOR 时自动关闭。"""
import os
import sys

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"

_CODES = {
    "red": "\033[31m",
    "green": "\033[32m",
    "yellow": "\033[33m",
    "blue": "\033[34m",
    "magenta": "\033[35m",
    "cyan": "\033[36m",
    "gray": "\033[90m",
    "bright_red": "\033[91m",
    "bright_green": "\033[92m",
    "bright_yellow": "\033[93m",
    "bright_blue": "\033[94m",
}


def _supports_color(stream):
    if os.environ.get("NO_COLOR") is not None:
        return False
    mode = os.environ.get("CC_MONITOR_COLOR")
    if mode == "always":
        return True
    if mode == "never":
        return False
    try:
        return stream.isatty()
    except (AttributeError, ValueError):
        return False


ENABLED = _supports_color(sys.stdout)


def c(text, color=None, bold=False, dim=False):
    """给文本包一层 ANSI 颜色码；颜色关闭时原样返回。"""
    if not ENABLED or not text:
        return text
    prefix = ""
    if bold:
        prefix += BOLD
    if dim:
        prefix += DIM
    if color:
        prefix += _CODES.get(color, "")
    if not prefix:
        return text
    return "{}{}{}".format(prefix, text, RESET)


RISK_COLOR = {"high": "bright_red", "medium": "yellow", "low": "green", "info": "gray"}
DECISION_COLOR = {"blocked": "bright_red", "allowed": "green", "completed": "cyan", "observed": "blue"}


def risk(text):
    return c(text, color=RISK_COLOR.get(text, "gray"), bold=(text == "high"))


def decision(text):
    return c(text, color=DECISION_COLOR.get(text, None), bold=(text == "blocked"))
