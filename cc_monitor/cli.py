import argparse
import json
import os
import platform
import shutil
import sys
import time
from collections import Counter
from pathlib import Path

from . import audit_state
from . import colors as col
from . import format as fmt
from . import policy, registry, rematch, storage, transcript

# 介入级别的显示文案。注意不要再写成"暂停审计"——paused 这一档审计照常在跑，
# 停下来的只是拦截，叫"暂停审计"会让人以为记录也断了（见 audit_state.py 的模块注释）。
STATE_LABELS = {
    "running": "拦截中（判定 + 记录 + 拦截）",
    "paused": "观察模式 permissive（判定 + 记录，不拦截、不弹确认框）",
    "stopped": "已关闭（不判定、不记录，等价于没装）",
}

DECISION_LABELS = {
    "allowed": "放行",
    "blocked": "拦截",
    "completed": "已完成",
    "observed": "系统观测",
}


_ESC = "\033["


def _color_extra_line(line):
    # "结果:"/"输出:" 这类行的内容已经在 format.py 里按字段/关键字精细上色过了
    # （比如输出里的报错关键字、文件路径），这里不能再整行套一层颜色——
    # ANSI reset 不是"退栈"，套了外层颜色之后遇到内层的 reset 会把外层也一起清掉，
    # 显示效果反而更花。原样透传，只处理还没上色的行（比如探针的 ⚠/✓ 提示）。
    if _ESC in line:
        return line
    if line.startswith("⚠"):
        return col.c(line, color="bright_red", bold=True)
    if line.startswith("✓") or "吻合" in line:
        return col.c(line, color="green")
    return col.c(line, color="gray")


def cmd_tail(args):
    last_id = 0
    print("[CC-Monitor] 实时查看监测事件，按 Ctrl+C 退出")
    try:
        while True:
            rows = storage.fetch_recent(limit=500, since_id=last_id)
            for row in rows:
                (id_, ts, source, tool_name, risk, matched_rule, decision, detail_raw, cwd) = row
                last_id = id_
                try:
                    detail = json.loads(detail_raw) if detail_raw else {}
                except json.JSONDecodeError:
                    detail = {}

                label, summary, extra = fmt.describe(tool_name, source, detail)
                decision_label = DECISION_LABELS.get(decision, decision)
                rule_text = matched_rule or "-"

                print(
                    "{ts} [{risk}] {stage} · {label} → {decision} (规则={rule}) {cwd}".format(
                        ts=col.c(ts, dim=True),
                        risk=col.risk(risk or "-"),
                        stage=col.c(fmt.stage_label(source), dim=True),
                        label=col.c(label, color="cyan", bold=True),
                        decision=col.c(decision_label, color=col.DECISION_COLOR.get(decision), bold=(decision == "blocked")),
                        rule=col.c(rule_text, color="magenta") if matched_rule else col.c(rule_text, dim=True),
                        cwd=col.c("cwd={}".format(cwd), dim=True),
                    )
                )
                if summary:
                    print("    内容: {}".format(summary))
                for line in extra:
                    print("    {}".format(_color_extra_line(line)))
                if args.verbose:
                    print("    {}".format(col.c("原始数据: {}".format(detail_raw), dim=True)))
            time.sleep(1)
    except KeyboardInterrupt:
        pass


def cmd_rules(args):
    print(json.dumps(policy.load_rules(), ensure_ascii=False, indent=2))


def cmd_rematch(args):
    """用当前生效的规则把审计库里所有 PreToolUse 事件重新判一遍（见 rematch.py 的说明）。
    默认只预览，--apply 才写库；--quiet 给 hook 后台自动触发用，不打印明细。"""
    total, changes = rematch.run(apply=args.apply)
    if args.quiet:
        return
    print("共检查 {} 条 PreToolUse 事件，{} 条的命中规则/风险等级会变化".format(total, len(changes)))
    for event_id, tool_name, old_rule, new_rule, new_risk, summary in changes:
        print("  #{} {} {} -> {} [{}]  {}".format(event_id, tool_name, old_rule or "-", new_rule or "-", new_risk, summary))
    if not changes:
        return
    if args.apply:
        print(col.c("已更新 {} 条事件的 risk/matched_rule".format(len(changes)), color="green", bold=True))
    else:
        print(col.c("以上只是预览，加 --apply 才会写入数据库", dim=True))


def cmd_stats(args):
    rows = storage.fetch_recent(limit=1_000_000, since_id=0)
    by_risk = Counter(r[4] for r in rows)
    by_decision = Counter(r[6] for r in rows)
    print("总事件数:", len(rows))
    print("按风险等级:", dict(by_risk))
    print("按决策结果:", dict(by_decision))
    by_agent = storage.count_by_agent()
    if by_agent:
        print("按 agent:", {registry.display_name(a): n for a, n in by_agent})


def cmd_run(args):
    from . import run as _run
    argv = list(args.command)
    if args.agent:
        argv = ["--agent", args.agent] + argv
    _run.main(argv)


def cmd_agents(args):
    """列出认识的 agent、本机有没有装、hook 有没有接、库里有多少条它的记录。"""
    counts = dict(storage.count_by_agent())
    print("{:<16} {:<16} {:<8} {:<8} {:<8} {}".format("id", "名称", "状态", "已安装", "hook", "事件数"))
    for aid in registry.ids():
        spec = registry.get(aid)
        hooks = spec.get("hooks") or {}
        cfg = hooks.get("config") or {}
        installed = shutil.which(spec.get("launch_command") or "") is not None
        hooked = "-"
        if cfg.get("user_path"):
            path = Path(os.path.expanduser(cfg["user_path"]))
            if path.exists():
                try:
                    hooked = "已接" if "CC-Monitor-hook" in path.read_text(encoding="utf-8") else "未接"
                except OSError:
                    hooked = "?"
            else:
                hooked = "未接"
        print("{:<16} {:<16} {:<8} {:<8} {:<8} {}".format(
            aid, spec["display"], "已验证" if spec.get("status") == "verified" else "实验性",
            "是" if installed else "-", hooked, counts.get(aid, 0)))
    print(col.c("接入某家 agent 的 hook：python3 install.py --agent <id>（或 --agent all）", dim=True))
    print(col.c("实验性 = 按官方文档/源码实现、尚未在真机验证；接入后请按 MULTI-AGENT.md §2.3 自行验证。", dim=True))


def cmd_verify(args):
    # 绕过检测的原理是拿系统层探针观测到的 execve 跟 hook 层记录的命令做比对。只有
    # Linux 的 bpftrace 探针看得到 execve；macOS 那份探针用的是 nettop，只覆盖网络，
    # 压根不产生 execve 观测，于是 hook_bypass_suspected 这个标记在 macOS 上恒为空。
    # 如果照旧打印绿色的"未发现可疑记录"，用户看到的是"检查通过"，实际是"从未检查过"——
    # 这种假安全感比没有这个功能更危险，所以在 macOS 上如实说明能力缺失。
    if platform.system() == "Darwin":
        print(col.c("本平台（macOS）不支持执行层交叉验证。", color="yellow", bold=True))
        print(
            "绕过检测要靠内核层观测每一次 execve，再跟 hook 记录比对。macOS 上的系统层探针用的是\n"
            "nettop，只能看到网络连接，看不到命令执行（Apple 的 Endpoint Security Framework 需要\n"
            "签过名的 system extension，见 DESIGN.md 的规划）。所以这里既不会报警，也不代表安全——\n"
            "是这项检查在本平台上根本没有运行。"
        )
        print(col.c("仍然有效的部分：hook 层的完整审计记录、以及探针的网络连接/流量观测。", dim=True))
        return

    rows = storage.fetch_last(limit=args.limit)
    suspects = [r for r in rows if r[5] == "hook_bypass_suspected"]
    if not suspects:
        print(col.c("未发现可疑记录：系统层探针（bpftrace）观测到的命令都能在 hook 记录里找到对应。", color="green"))
        print(col.c("（前提是 `sudo CC-Monitor-probe` 探针在运行；没运行的话这里永远是空的。）", dim=True))
        return
    print(col.c("⚠ 发现 {} 条系统层观测到、但 hook 层没有对应记录的命令（可能绕过了监测）：".format(len(suspects)), color="bright_red", bold=True))
    for row in suspects:
        (_id, ts, _source, tool_name, _risk, _rule, _decision, detail_raw, _cwd) = row
        try:
            detail = json.loads(detail_raw)
        except json.JSONDecodeError:
            detail = {}
        cmd_text = detail.get("shell_command") or detail.get("argv") or (
            "文件{} {}".format(detail.get("op", ""), detail.get("path", "")) if detail.get("path") else "")
        print(
            "  [{ts}] agent={agent} pid={pid} comm={comm} 命令: {cmd}".format(
                ts=col.c(ts, dim=True),
                agent=detail.get("agent") or "?",
                pid=detail.get("pid"),
                comm=col.c(str(tool_name), color="cyan"),
                cmd=col.c(cmd_text[:200], color="yellow"),
            )
        )


WORKDIR_RULE_LABELS = {
    "workdir_escape_write_sensitive": "写入 · 敏感位置（家目录隐藏文件/别的用户/系统目录）",
    "workdir_escape_write_other": "写入 · 其它项目目录",
    "workdir_escape_read_sensitive": "读取 · 敏感位置（家目录隐藏文件/别的用户）",
    "workdir_escape_read_other": "读取 · 系统目录/其它项目目录",
}


def cmd_workdir(args):
    """列出 AI 跑到当前工作目录之外去操作文件的记录（命中 workdir_escape_* 规则的事件）。"""
    rows = storage.fetch_by_rule_prefix("workdir_escape_", limit=args.limit)
    if not rows:
        print(col.c("没有发现跨工作目录的文件操作记录。", color="green"))
        print(col.c("（只统计命中 workdir_escape_* 规则的事件；被更具体的规则先命中的，比如读 ~/.ssh，算在那条规则里。）", dim=True))
        return
    by_rule = Counter(r[5] for r in rows)
    print(col.c("最近 {} 条跨工作目录的文件操作：".format(len(rows)), bold=True))
    for rule, n in by_rule.most_common():
        print("  {} {}".format(col.c(str(n).rjust(5), color="cyan"), WORKDIR_RULE_LABELS.get(rule, rule)))
    print()
    for row in rows:
        (_id, ts, _source, tool_name, risk, matched_rule, decision, detail_raw, cwd) = row
        try:
            detail = json.loads(detail_raw) if detail_raw else {}
        except json.JSONDecodeError:
            detail = {}
        _label, summary, _extra = fmt.describe(tool_name, "hook_pre", detail)
        print(
            "{ts} [{risk}] {tool} → {decision} {rule}  {cwd}".format(
                ts=col.c(ts, dim=True),
                risk=col.risk(risk or "-"),
                tool=col.c(fmt.TOOL_LABELS.get(tool_name, tool_name), color="cyan", bold=True),
                decision=col.c(DECISION_LABELS.get(decision, decision), color=col.DECISION_COLOR.get(decision), bold=(decision == "blocked")),
                rule=col.c(WORKDIR_RULE_LABELS.get(matched_rule, matched_rule), color="magenta"),
                cwd=col.c("cwd={}".format(cwd), dim=True),
            )
        )
        if summary:
            print("    内容: {}".format(summary))


def cmd_tap(args):
    session_id = args.session or storage.get_latest_session_id()
    if not session_id:
        print("还没有任何审计事件，找不到可用的 session。先让 Claude Code 跑点操作再试。")
        return

    path = storage.get_transcript_path(session_id)
    if not path:
        print(
            "没找到 session {} 对应的 transcript 文件——可能这个 session 是在装 hook 之前开始的，"
            "还没有任何一次工具调用被记录过 transcript_path。".format(session_id)
        )
        return

    print(col.c("[CC-Monitor] Session: {}".format(session_id), bold=True))
    print(col.c("[CC-Monitor] Transcript: {}".format(path), dim=True))

    if not args.follow:
        entries, _ = transcript.read_entries(path, start_line=0, limit=args.limit)
        for e in entries:
            for line in transcript.render_entry_cli(e):
                print(line)
        return

    total = transcript.count_lines(path)
    start_line = max(0, total - 20)
    print(col.c("实时追踪中，按 Ctrl+C 退出", dim=True))
    try:
        while True:
            entries, start_line = transcript.read_entries(path, start_line=start_line, limit=1000)
            for e in entries:
                for line in transcript.render_entry_cli(e):
                    print(line)
            time.sleep(1)
    except KeyboardInterrupt:
        pass


def cmd_audit(args):
    if args.action == "status":
        info = audit_state.get_state_info()
        label = STATE_LABELS.get(info["state"], info["state"])
        print(col.c("当前状态: {}".format(label), bold=True))
        if info.get("changedAt"):
            print(col.c("切换时间: {}".format(info["changedAt"]), dim=True))
        return
    state = {
        "start": "running",
        "enforcing": "running",
        # permissive 是主推的名字，pause 保留下来是为了不打断老用户的肌肉记忆和已有脚本。
        "permissive": "paused",
        "observe": "paused",
        "pause": "paused",
        "stop": "stopped",
        "off": "stopped",
    }[args.action]
    audit_state.set_state(state)
    print(col.c("已切换到: {}".format(STATE_LABELS[state]), color="green", bold=True))


def main():
    parser = argparse.ArgumentParser(prog="CC-Monitor", description="CC-Monitor：AI coding agent（Claude Code / Codex / Gemini CLI / Cursor / OpenCode…）操作监测工具")
    sub = parser.add_subparsers(dest="cmd")

    p_tail = sub.add_parser("tail", help="实时查看监测事件")
    p_tail.add_argument("-v", "--verbose", action="store_true", help="打印事件详情")
    p_tail.set_defaults(func=cmd_tail)

    p_rules = sub.add_parser("rules", help="查看当前生效的规则")
    p_rules.set_defaults(func=cmd_rules)

    p_rematch = sub.add_parser("rematch", help="用当前规则重新判定历史事件的命中规则（默认只预览，--apply 才写库）")
    p_rematch.add_argument("--apply", action="store_true", help="真的更新数据库里的 risk/matched_rule")
    p_rematch.add_argument("--quiet", action="store_true", help="不打印明细（hook 后台自动触发时用）")
    p_rematch.set_defaults(func=cmd_rematch)

    p_stats = sub.add_parser("stats", help="查看统计信息")
    p_stats.set_defaults(func=cmd_stats)

    p_agents = sub.add_parser("agents", help="列出认识的 AI agent 及各自的接入状态")
    p_agents.set_defaults(func=cmd_agents)

    p_run = sub.add_parser("run", help="显式把一个命令绑定成某家 agent 的根进程再执行：CC-Monitor run [--agent <id>] -- <命令>")
    p_run.add_argument("--agent", default=None, help="agent id（不传就按注册表特征猜，猜不出记为 generic）")
    p_run.add_argument("command", nargs=argparse.REMAINDER, help="要执行的命令（前面加 -- ）")
    p_run.set_defaults(func=cmd_run)

    p_verify = sub.add_parser("verify", help="查看系统层探针标记的可疑（疑似绕过监测）记录")
    p_verify.add_argument("--limit", type=int, default=5000, help="最多回溯检查多少条事件")
    p_verify.set_defaults(func=cmd_verify)

    p_workdir = sub.add_parser("workdir", help="查看 AI 跨出工作目录去读写文件的记录（命中 workdir_escape_* 规则的事件）")
    p_workdir.add_argument("--limit", type=int, default=100, help="最多显示多少条（默认 100）")
    p_workdir.set_defaults(func=cmd_workdir)

    p_tap = sub.add_parser("tap", help="Claude Tap：查看某个 session 发给/收到模型的完整对话内容")
    p_tap.add_argument("--session", help="session id（不指定则用最近一次监测到的 session）")
    p_tap.add_argument("--limit", type=int, default=200, help="非 -f 模式下最多显示多少条")
    p_tap.add_argument("-f", "--follow", action="store_true", help="像 tail -f 一样持续追踪新内容")
    p_tap.set_defaults(func=cmd_tap)

    p_audit = sub.add_parser(
        "audit",
        help="切换介入级别（拦截 / 观察模式 permissive / 关闭），或查看当前级别",
    )
    p_audit.add_argument(
        "action",
        choices=[
            "start", "enforcing",
            "permissive", "observe", "pause",
            "stop", "off",
            "status",
        ],
        help=(
            "start/enforcing=正常拦截；permissive/observe=观察模式，只记录不拦截不弹框"
            "（pause 是它的旧名字，仍可用）；stop/off=完全不介入；status=查看当前级别"
        ),
    )
    p_audit.set_defaults(func=cmd_audit)

    args = parser.parse_args()
    if not args.cmd:
        parser.print_help()
        sys.exit(1)
    args.func(args)


if __name__ == "__main__":
    main()
