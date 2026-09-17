"""介入级别开关：拦截 / 观察 / 关闭。

存一个小状态文件（不用数据库，读写都是原子的单文件操作，hook 每次调用都要读一遍，
开销要尽量小）。三种级别的语义不一样，不是简单的"开/关"两态：

- running（默认）：完全正常——按规则判定放行/拦截/确认，全部记录。
- paused / permissive：观察模式，只记录不拦截——仍然按规则跑一遍算出 risk/matched_rule
  记下来，但从不真的拦截或弹确认框，一律放行。适合"我知道接下来这批操作有点危险，但不
  想被打断，等下再看记录"，也适合长期挂着先摸清楚 AI 到底在干什么再决定拦什么。
  命名参考 SELinux 的 permissive / AppArmor 的 complain：判定照跑、违规照记，只是不阻止。
- stopped：完全不介入——不判定、不记录，等价于没装这个 hook。适合排查"是不是 CC-Monitor
  自己导致了某个问题"，或者单纯不想留任何记录。

注意"审计"这个词只有 stopped 那一档才真的停掉；running 和 permissive 两档审计都照常在跑，
所以对外文案一律说"介入级别 / 观察模式"，不说"暂停审计"。

磁盘上存的仍然是 running/paused/stopped 三个值——permissive 是 paused 的别名，入口处
归一化掉，这样老版本的 CC-Monitor、以及任何直接读这个文件或调 /api/audit-state 的脚本
都不会因为改名而失效。
"""
import json
import os
import time
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("CC_MONITOR_HOME", str(Path.home() / ".cc-monitor")))
STATE_FILE = CONFIG_DIR / "audit_state.json"

# 落盘用的规范值，不要改——外部脚本和老版本都按这三个值读。
VALID_STATES = ("running", "paused", "stopped")

# 对外可以接受的别名 -> 规范值。permissive/observe 说的都是 paused 这一档，
# enforcing 说的是 running，disabled/off 说的是 stopped。
STATE_ALIASES = {
    "permissive": "paused",
    "observe": "paused",
    "log-only": "paused",
    "log_only": "paused",
    "enforcing": "running",
    "enforce": "running",
    "disabled": "stopped",
    "off": "stopped",
}


def normalize_state(state):
    """把别名折算成落盘用的规范值；已经是规范值就原样返回，都不认返回 None。"""
    if not isinstance(state, str):
        return None
    s = state.strip().lower()
    if s in VALID_STATES:
        return s
    return STATE_ALIASES.get(s)


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
    canonical = normalize_state(state)
    if canonical is None:
        raise ValueError(
            "state 必须是 {} 之一（也接受别名 {}）".format(VALID_STATES, tuple(STATE_ALIASES))
        )
    state = canonical
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(
        json.dumps({"state": state, "changedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}),
        encoding="utf-8",
    )
