"""审计开关：开始/暂停/停止。

存一个小状态文件（不用数据库，读写都是原子的单文件操作，hook 每次调用都要读一遍，
开销要尽量小）。三种状态的语义不一样，不是简单的"开/关"两态：

- running（默认）：完全正常——按规则判定放行/拦截/确认，全部记录。
- paused：只观察不拦截——仍然按规则跑一遍算出 risk/matched_rule 记下来，但从不真的拦截
  或弹确认框，一律放行。适合"我知道接下来这批操作有点危险，但不想被打断，等下再看记录"。
- stopped：完全不介入——不判定、不记录，等价于没装这个 hook。适合排查"是不是 CC-Monitor
  自己导致了某个问题"，或者单纯不想留任何记录。
"""
import json
import os
import time
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("CC_MONITOR_HOME", str(Path.home() / ".cc-monitor")))
STATE_FILE = CONFIG_DIR / "audit_state.json"

VALID_STATES = ("running", "paused", "stopped")


def get_state():
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        state = data.get("state")
        if state in VALID_STATES:
            return state
    except (OSError, json.JSONDecodeError):
        pass
    return "running"


def get_state_info():
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if data.get("state") in VALID_STATES:
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {"state": "running", "changedAt": None}


def set_state(state):
    if state not in VALID_STATES:
        raise ValueError("state 必须是 {} 之一".format(VALID_STATES))
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(
        json.dumps({"state": state, "changedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}),
        encoding="utf-8",
    )
