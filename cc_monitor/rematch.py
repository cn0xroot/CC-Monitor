"""规则改了之后，把审计库里已有的 PreToolUse 事件用当前规则重新判一遍。

首页那些统计卡片（软件安装、敏感操作、敏感数据……）全是按 events.matched_rule 聚合的，
而 matched_rule 是 hook 在事件发生那一刻按"当时的规则"算出来写死的。规则修过误报/
漏报之后，如果历史事件不重判，卡片上的数字就一直是错的（修 port 误报之前累积的 10 条
"系统包管理器安装"全是 grep/heredoc 里提到了字样的误报，规则修好了它们也不会自己消失）。

两条触发路径：
- 自动：hook 每次调用算一下当前规则表的指纹（policy.rules_fingerprint），跟 meta 表里
  记的"上次重判用的指纹"不一样就认领并后台起一个独立进程跑 run(apply=True)。hook
  本身不做重判——几千条事件逐条过一遍正则要几秒，PreToolUse 不能卡这么久。
- 手动：`CC-Monitor rematch` 预览会改哪些，`--apply` 真的写。

只改 risk/matched_rule 两列，decision（当时真实的放行/拦截结果）永远不动；归档库
（archives/）不碰。
"""
import json
import os
import subprocess
import sys
from pathlib import Path

from . import policy, storage

FINGERPRINT_KEY = "rules_fingerprint"


def run(apply=False, rules=None):
    """返回 (total, changes)；changes 是 [(event_id, tool_name, old_rule, new_rule, new_risk, summary)]。"""
    if rules is None:
        rules = policy.load_rules()
    changes = []
    total = 0
    for event_id, tool_name, risk, matched_rule, detail_raw, cwd in storage.iter_hook_pre_events():
        total += 1
        try:
            tool_input = json.loads(detail_raw) if detail_raw else {}
        except json.JSONDecodeError:
            continue
        if not isinstance(tool_input, dict):
            continue
        rule, _ = policy.evaluate(tool_name or "", tool_input, rules=rules, cwd=cwd)
        new_rule = rule["id"] if rule else None
        new_risk = rule["risk"] if rule else "low"
        if new_rule != matched_rule or (new_rule and new_risk != risk):
            summary = tool_input.get("command") or tool_input.get("file_path") or tool_input.get("path") or ""
            summary = " ".join(str(summary).split())[:90]
            changes.append((event_id, tool_name, matched_rule, new_rule, new_risk, summary))
    if apply:
        storage.update_event_matches([(new_risk, new_rule, event_id) for event_id, _, _, new_rule, new_risk, _ in changes])
        storage.claim_meta(FINGERPRINT_KEY, policy.rules_fingerprint(rules))
    return total, changes


def maybe_schedule(rules):
    """hook 里调用：规则指纹跟上次重判的不一样就后台起一个 rematch --apply。
    认领成功才起进程，失败/异常一律静默——这只是个善后动作，不能影响 hook 主流程。"""
    try:
        fp = policy.rules_fingerprint(rules)
        if not storage.claim_meta(FINGERPRINT_KEY, fp):
            return False
        launcher = Path(__file__).resolve().parent.parent / "bin" / "CC-Monitor"
        if launcher.exists():
            cmd = [sys.executable, str(launcher), "rematch", "--apply", "--quiet"]
        else:
            cmd = [sys.executable, "-m", "cc_monitor.cli", "rematch", "--apply", "--quiet"]
        subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            cwd=str(Path(__file__).resolve().parent.parent),
            env=dict(os.environ),
        )
        return True
    except Exception:
        return False
