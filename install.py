#!/usr/bin/env python3
"""将 CC-Monitor 的 PreToolUse/PostToolUse/PermissionRequest hooks 安装到 Claude Code 的 settings.json。

用法:
    python3 install.py                     # 安装到全局 ~/.claude/settings.json
    python3 install.py --project DIR       # 安装到指定项目的 DIR/.claude/settings.json
    python3 install.py --target FILE       # 安装到指定的 settings.json（用于以其它用户身份安装，避免依赖 HOME）
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
HOOK_BIN = REPO_ROOT / "bin" / "CC-Monitor-hook"


def merge_hooks(settings, hook_cmd_pre, hook_cmd_post, hook_cmd_permission=None):
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
    # PermissionRequest：Claude Code 自己准备弹原生"Do you want to proceed?"时触发，
    # 用来把那些没命中我们 confirm 规则、但 Claude Code 自己要问的工具调用也同步到
    # "AI 审批台"（老版本装的配置里没有这一条，重跑 install 会补上，已有的两条不动）。
    if hook_cmd_permission:
        add("PermissionRequest", hook_cmd_permission)
    return settings


def configure_statusline(settings):
    """把 ccstatusline 接进 Claude Code 的终端状态栏（跟额度/账号页用的是同一份读取
    逻辑，见 webui/lib/usage.js 顶部注释）。两个条件都要满足才动手：
      1. 系统上已经装了 ccstatusline（install.sh 会先跑 npm install -g，这里只管接线，
         不负责装包——直接调 python 装 npm 包不现实，也不该跨语言耦合）；
      2. settings.json 里还没有 statusLine 这个键。
    任何一个条件不满足就什么都不做：没装就没法接（接了也是空跑），已经配置过（不管是不是
    ccstatusline、不管什么参数）就绝不覆盖——用户可能特地调过 padding/refreshInterval，或者
    换了别的状态栏工具，这些定制都不该被 install.py 静默冲掉。
    返回 True 表示这次真的写了配置，False 表示跳过（没装 / 已配置，调用方用这个决定要不要
    打印提示）。
    """
    if "statusLine" in settings:
        return False
    if not shutil.which("ccstatusline"):
        return False
    settings["statusLine"] = {
        "type": "command",
        "command": "ccstatusline",
        "padding": 0,
        "refreshInterval": 10,
    }
    return True


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
    parser.add_argument(
        "--skip-statusline",
        action="store_true",
        help="不把 ccstatusline 接进 statusLine 配置（install.sh 的 --skip-ccstatusline 会转成这个）",
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
    hook_cmd_permission = '"{}" permission'.format(HOOK_BIN)
    settings = merge_hooks(settings, hook_cmd_pre, hook_cmd_post, hook_cmd_permission)
    statusline_configured = False if args.skip_statusline else configure_statusline(settings)

    target.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("已写入: {}".format(target))
    print("Hook 脚本: {}".format(HOOK_BIN))
    print("重启 Claude Code 后生效。可用 `{}/bin/CC-Monitor tail` 实时查看监测事件。".format(REPO_ROOT))
    if statusline_configured:
        print("已配置 statusLine: ccstatusline（终端里会显示模型/额度/git 分支等状态栏信息）")
    elif args.skip_statusline:
        print("跳过 statusLine 配置（--skip-statusline）。")
    elif "statusLine" not in settings:
        print("未配置 statusLine：没有检测到 ccstatusline，跑一遍 install.sh 会自动装上并接线，"
              "或者手动 `npm install -g ccstatusline` 后重跑 install.py")


if __name__ == "__main__":
    main()
