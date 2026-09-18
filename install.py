#!/usr/bin/env python3
"""把 CC-Monitor 的 hooks 装进各家 AI agent 的配置里。

    python3 install.py                        # Claude Code：~/.claude/settings.json（跟以前完全一样）
    python3 install.py --agent codex          # Codex CLI：~/.codex/hooks.json
    python3 install.py --agent gemini-cli     # Gemini CLI：~/.gemini/settings.json 的 hooks 块
    python3 install.py --agent cursor         # Cursor：~/.cursor/hooks.json
    python3 install.py --agent opencode       # OpenCode：~/.config/opencode/plugins/cc-monitor.js
    python3 install.py --agent zcode          # ZCode：~/.zcode/cli/config.json 的 hooks.events 块
    python3 install.py --agent antigravity-cli # Antigravity CLI：~/.gemini/config/hooks.json 的 "cc-monitor" 组
    python3 install.py --agent grok-cli       # Grok CLI：~/.grok/user-settings.json 的 hooks 块

除 Claude Code 外的接入都是实验性的（按官方文档/源码实现，尚未真机验证），--list 里有标注。
    python3 install.py --agent all            # 上面全部（只装本机检测到已安装的那些，--force-all 不做检测）
    python3 install.py --list                 # 列出认识的 agent 和各自的配置文件路径
    python3 install.py --project DIR          # 装到项目级配置（各家 agent 的项目级路径见 --list）
    python3 install.py --target FILE          # 直接指定配置文件路径（跨用户安装用）

每家 agent 长什么样（事件名、配置路径、工具名映射）都在 cc_monitor/agents/<id>.json 里，
这个脚本本身不认识任何一家。幂等：已经装过的条目不重复加，用户自己配的其它 hook 一律不动。
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO_ROOT))
from cc_monitor import adapters, registry  # noqa: E402

HOOK_BIN = REPO_ROOT / "bin" / "CC-Monitor-hook"


# ---- 通用合并 ----

def _entry_commands(entry):
    """一个 hooks 条目里所有"命令身份"字符串——Claude/Codex/Gemini 是 entry.hooks[].command，
    Cursor 是 entry.command，ZCode 的 process 类型是 command + args 拼起来（同一个可执行文件
    带不同参数挂在不同事件下，不能只看 command）。"""
    cmds = []

    def ident(h):
        cmd = h.get("command")
        if not isinstance(cmd, str):
            return None
        args = h.get("args")
        return cmd + " " + " ".join(map(str, args)) if isinstance(args, list) else cmd

    if isinstance(entry, dict):
        if ident(entry):
            cmds.append(ident(entry))
        for h in entry.get("hooks") or []:
            if isinstance(h, dict) and ident(h):
                cmds.append(ident(h))
    return cmds


def merge_hook_entries(hooks, new_hooks):
    """hooks 是配置文件里现有的 {event: [entries]}，new_hooks 是要加的。同一个 command 已经在
    某个 event 下了就跳过（老版本装过），其它条目原样保留。返回加了几条。"""
    added = 0
    for event_name, entries in new_hooks.items():
        existing = hooks.setdefault(event_name, [])
        for entry in entries:
            wanted = set(_entry_commands(entry))
            if any(wanted & set(_entry_commands(e)) for e in existing):
                continue
            existing.append(entry)
            added += 1
    return added


def merge_hooks(settings, hook_cmd_pre, hook_cmd_post, hook_cmd_permission=None, extra_hooks=None):
    """老接口（Claude Code 专用形状），留给还在 import 它的脚本/测试用。"""
    new_hooks = {}

    def add(event_name, command):
        new_hooks[event_name] = [{"matcher": "*", "hooks": [{"type": "command", "command": command}]}]

    add("PreToolUse", hook_cmd_pre)
    add("PostToolUse", hook_cmd_post)
    if hook_cmd_permission:
        add("PermissionRequest", hook_cmd_permission)
    for event_name, command in (extra_hooks or {}).items():
        add(event_name, command)
    merge_hook_entries(settings.setdefault("hooks", {}), new_hooks)
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


def _read_json(target):
    if not target.exists():
        return {}
    try:
        return json.loads(target.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        backup = target.with_suffix(".json.bak")
        print("警告: {} 不是合法 JSON，已备份为 {} 并重建".format(target, backup), file=sys.stderr)
        target.rename(backup)
        return {}


def _write_json(target, data):
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def resolve_target(spec, args):
    cfg = spec["hooks"]["config"]
    if args.target:
        return Path(args.target).resolve()
    if args.project:
        return Path(args.project).resolve() / cfg["project_path"]
    return Path(os.path.expanduser(cfg["user_path"]))


def agent_installed(spec):
    """这家 agent 本机装了吗——launch_command 在 PATH 里，或者它自己的状态目录已经存在
    （state_dirs 的第一项，比如 ~/.codex、~/.grok；不看配置文件的父目录，~/.gemini 下面住着
    Gemini CLI 和 Antigravity 两家，光看它存在说明不了谁装了）。"""
    if shutil.which(spec.get("launch_command") or ""):
        return True
    for rel in (spec.get("state_dirs") or [])[:1]:
        if Path(os.path.expanduser("~")).joinpath(rel).exists():
            return True
    return False


# ---- 各种配置文件形状 ----

def install_agent(agent_id, args):
    spec = registry.get(agent_id)
    if not spec or not spec.get("hooks"):
        print("{}：没有应用层 hook 协议，只能靠系统层探针观测（sudo bin/CC-Monitor-probe）".format(
            registry.display_name(agent_id)))
        return
    kind = spec["hooks"]["config"]["kind"]
    adapter = adapters.for_agent(agent_id)
    target = resolve_target(spec, args)
    new_hooks = adapter.hook_config_entries(str(HOOK_BIN), agent_id, spec["hooks"]["events"])

    if kind == "opencode-plugin":
        src = REPO_ROOT / "cc_monitor" / "adapters" / "opencode_plugin.js"
        text = src.read_text(encoding="utf-8").replace("__CC_MONITOR_HOOK_BIN__", str(HOOK_BIN))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        print("已写入 OpenCode 插件: {}".format(target))
        print("重启 opencode 后生效（插件目录里的文件会被自动加载）。")
        return

    settings = _read_json(target)
    if kind == "cursor-hooks":
        settings.setdefault("version", 1)
    if kind == "antigravity-hooks":
        # Antigravity：hooks.json 按 "hook 名" 分组，我们独占 "cc-monitor" 这一组，别的组不动。
        # 组内内容由适配器整体生成，重跑就是原样覆盖（幂等），别人的组原样保留。
        before = settings.get("cc-monitor")
        settings["cc-monitor"] = new_hooks
        added = 0 if before == new_hooks else len([k for k in new_hooks if k != "enabled"])
    elif kind == "zcode-config":
        # ZCode：hooks 是 {"enabled": true, "events": {...}}，事件挂在 events 下；enabled 不为 true
        # 一个 hook 都不会跑。用户可能已经有别的插件 hook，同样只追加不覆盖。
        hooks_block = settings.setdefault("hooks", {})
        if not isinstance(hooks_block, dict):
            hooks_block = settings["hooks"] = {}
        hooks_block["enabled"] = True
        added = merge_hook_entries(hooks_block.setdefault("events", {}), new_hooks)
    else:
        added = merge_hook_entries(settings.setdefault("hooks", {}), new_hooks)

    statusline_configured = False
    if kind == "claude-settings" and not args.skip_statusline:
        statusline_configured = configure_statusline(settings)

    _write_json(target, settings)
    print("[{}] 已写入: {}（新增 {} 条 hook，已有的不动）".format(spec["display"], target, added))

    if kind == "claude-settings":
        print("重启 Claude Code 后生效。可用 `{}/bin/CC-Monitor tail` 实时查看监测事件。".format(REPO_ROOT))
        if statusline_configured:
            print("已配置 statusLine: ccstatusline（终端里会显示模型/额度/git 分支等状态栏信息）")
        elif args.skip_statusline:
            print("跳过 statusLine 配置（--skip-statusline）。")
        elif "statusLine" not in settings:
            print("未配置 statusLine：没有检测到 ccstatusline，跑一遍 install.sh 会自动装上并接线，"
                  "或者手动 `npm install -g ccstatusline` 后重跑 install.py")
    elif kind == "codex-hooks":
        _check_codex_feature_flag(target.parent / "config.toml")
        print("重启 codex 后生效。")
    elif kind == "gemini-settings":
        print("重启 gemini 后生效。")
    elif kind == "cursor-hooks":
        print("Cursor 会自动重新加载 hooks.json；Cursor CLI（cursor-agent）是否本地执行 hook 以实测为准。")
    elif kind == "zcode-config":
        print("重启 ZCode（桌面版或 zcode CLI）后生效。注意 ZCode 当前版本忽略项目级 .zcode/config.json 里的 hooks，只认用户级。")
    elif kind == "antigravity-hooks":
        print("重启 agy 后生效。hooks.json 里我们独占 \"cc-monitor\" 这一组，其它组不动。")
    elif kind == "grok-user-settings":
        print("重启 grok 后生效。注意 grok-cli 只读用户级 ~/.grok/user-settings.json 的 hooks，项目级 .grok/settings.json 的 hooks 被它忽略。")
    if spec.get("status") == "experimental":
        print(col_warn("注意：{} 的接入是实验性的——按官方文档/源码实现，尚未在真机上验证。装完请按 MULTI-AGENT.md §2.3 做一次验证。".format(spec["display"])))


def _check_codex_feature_flag(config_toml):
    """Codex 的 hooks 受 config.toml 里 [features] hooks 开关控制。不改用户的 toml（没有
    标准库 toml 写入器，硬改容易把用户的注释/格式弄坏），只检查并提示。"""
    try:
        text = config_toml.read_text(encoding="utf-8")
    except OSError:
        text = ""
    if "hooks = false" in text.replace(" ", " ") or "codex_hooks = false" in text:
        print("注意: {} 里 hooks 被显式关掉了（[features] hooks = false），改成 true 才会触发。".format(config_toml))
    elif "hooks = true" not in text and "codex_hooks = true" not in text:
        print("提示: 如果 hook 没触发，在 {} 加上:\n  [features]\n  hooks = true".format(config_toml))


def col_warn(text):
    return "\033[33m{}\033[0m".format(text) if sys.stdout.isatty() else text


def list_agents():
    print("{:<16} {:<16} {:<10} {:<8} {}".format("id", "名称", "状态", "已安装", "配置文件"))
    for aid in registry.ids():
        spec = registry.get(aid)
        hooks = spec.get("hooks") or {}
        cfg = hooks.get("config") or {}
        print("{:<16} {:<16} {:<10} {:<8} {}".format(
            aid, spec["display"], "已验证" if spec.get("status") == "verified" else "实验性",
            "是" if agent_installed(spec) else "-",
            cfg.get("user_path") or "（无应用层 hook，仅系统层探针）"))
    print("实验性 = 按官方文档/源码实现、尚未在真机验证；接入后请按 MULTI-AGENT.md §2.3 自行验证。")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", default="claude-code",
                        help="要接入的 agent id（见 --list），或 all；默认 claude-code")
    parser.add_argument("--list", action="store_true", help="列出认识的 agent 及配置文件路径")
    parser.add_argument("--force-all", action="store_true", help="--agent all 时不做本机安装检测，全部写入")
    parser.add_argument("--project", help="安装到指定项目目录的项目级配置，而非用户级")
    parser.add_argument("--target", help="直接指定配置文件的绝对路径（优先级最高，用于跨用户安装）")
    parser.add_argument("--skip-statusline", action="store_true",
                        help="不把 ccstatusline 接进 Claude Code 的 statusLine 配置")
    args = parser.parse_args()

    if args.list:
        list_agents()
        return

    os.chmod(REPO_ROOT / "bin" / "CC-Monitor", 0o755)
    os.chmod(HOOK_BIN, 0o755)

    if args.agent == "all":
        if args.target:
            print("--agent all 不能和 --target 同时用（每家 agent 的配置文件不同）", file=sys.stderr)
            sys.exit(2)
        for aid in registry.hook_capable_ids():
            spec = registry.get(aid)
            if not args.force_all and not agent_installed(spec):
                print("跳过 {}：本机没检测到（--force-all 可强制写入）".format(spec["display"]))
                continue
            install_agent(aid, args)
        return

    if registry.get(args.agent) is None:
        print("不认识的 agent: {}（可用: {}）".format(args.agent, ", ".join(registry.ids())), file=sys.stderr)
        sys.exit(2)
    install_agent(args.agent, args)
    print("Hook 脚本: {}".format(HOOK_BIN))


if __name__ == "__main__":
    main()
