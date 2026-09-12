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
            return str(value)
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
