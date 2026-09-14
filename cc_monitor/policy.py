import json
import os
import re
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("CC_MONITOR_HOME", str(Path.home() / ".cc-monitor")))
RULES_PATH = CONFIG_DIR / "rules.json"
DEFAULT_RULES_PATH = Path(__file__).parent / "default_rules.json"

FIELD_CANDIDATES = {
    "command": ["command"],
    "file_path": ["file_path", "path", "notebook_path"],
    "url": ["url"],
    # Write 用 "content"，Edit 用 "new_string"，NotebookEdit 用 "new_source"——
    # 三个工具语义上都是"即将写进文件的内容"，一条按内容扫描密钥格式的规则要
    # 同时认这三个字段名，跟上面 file_path 的多候选写法是同一个道理。
    "content": ["content", "new_string", "new_source"],
}


def ensure_config():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if not RULES_PATH.exists():
        RULES_PATH.write_text(
            DEFAULT_RULES_PATH.read_text(encoding="utf-8"), encoding="utf-8"
        )


def load_rules():
    ensure_config()
    try:
        return json.loads(RULES_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return json.loads(DEFAULT_RULES_PATH.read_text(encoding="utf-8"))


def _extract(tool_input, field):
    for key in FIELD_CANDIDATES.get(field, [field]):
        value = tool_input.get(key)
        if value is not None:
            if isinstance(value, str):
                return value
            # 不是字符串的字段（比如 AskUserQuestion 的 questions 是个列表）——用
            # json.dumps 而不是 str()，后者是 Python repr（单引号、True/False 大写
            # 那一套），前端拿到手没法当 JSON 解析；已有规则的 field 全是字符串
            # （command/file_path/url），这个分支不会改变它们的行为。
            return json.dumps(value, ensure_ascii=False)
    return None


def evaluate(tool_name, tool_input):
    """Return (rule, matched_value) for the first matching rule, or (None, None)."""
    for rule in load_rules():
        tools = rule.get("tools", ["*"])
        if "*" not in tools and tool_name not in tools:
            continue
        value = _extract(tool_input, rule["field"])
        if value is None:
            continue
        try:
            if re.search(rule["pattern"], value, re.IGNORECASE):
                return rule, value
        except re.error:
            continue
    return None, None
