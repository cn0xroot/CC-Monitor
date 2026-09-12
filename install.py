#!/usr/bin/env python3
"""将 CC-Monitor 的 PreToolUse/PostToolUse hooks 安装到 Claude Code 的 settings.json。

用法:
    python3 install.py                     # 安装到全局 ~/.claude/settings.json
    python3 install.py --project DIR       # 安装到指定项目的 DIR/.claude/settings.json
    python3 install.py --target FILE       # 安装到指定的 settings.json（用于以其它用户身份安装，避免依赖 HOME）
"""
import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
HOOK_BIN = REPO_ROOT / "bin" / "CC-Monitor-hook"


def merge_hooks(settings, hook_cmd_pre, hook_cmd_post):
    hooks = settings.setdefault("hooks", {})

    def add(event_name, command):
        entries = hooks.setdefault(event_name, [])
        for entry in entries:
            for h in entry.get("hooks", []):
                if h.get("command") == command:
                    return  # 已安装过，跳过
        entries.append({"matcher": "*", "hooks": [{"type": "command", "command": command}]})

    add("PreToolUse", hook_cmd_pre)
    add("PostToolUse", hook_cmd_post)
    return settings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--project",
        help="安装到指定项目目录的 .claude/settings.json，而非全局 ~/.claude/settings.json",
    )
    parser.add_argument(
        "--target",
        help="直接指定 settings.json 的绝对路径（优先级最高，用于跨用户安装）",
    )
    args = parser.parse_args()

    if args.target:
        target = Path(args.target).resolve()
    elif args.project:
        target = Path(args.project).resolve() / ".claude" / "settings.json"
    else:
        target = Path.home() / ".claude" / "settings.json"

    target.parent.mkdir(parents=True, exist_ok=True)

    settings = {}
    if target.exists():
        try:
            settings = json.loads(target.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            backup = target.with_suffix(".json.bak")
            print(
                "警告: {} 不是合法 JSON，已备份为 {} 并重建".format(target, backup),
                file=sys.stderr,
            )
            target.rename(backup)
            settings = {}

    os.chmod(REPO_ROOT / "bin" / "CC-Monitor", 0o755)
    os.chmod(HOOK_BIN, 0o755)

    hook_cmd_pre = '"{}" pre'.format(HOOK_BIN)
    hook_cmd_post = '"{}" post'.format(HOOK_BIN)
    settings = merge_hooks(settings, hook_cmd_pre, hook_cmd_post)

    target.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("已写入: {}".format(target))
    print("Hook 脚本: {}".format(HOOK_BIN))
    print("重启 Claude Code 后生效。可用 `{}/bin/CC-Monitor tail` 实时查看监测事件。".format(REPO_ROOT))


if __name__ == "__main__":
    main()
