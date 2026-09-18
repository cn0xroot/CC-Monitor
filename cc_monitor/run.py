"""`CC-Monitor run [--agent <id>] -- <命令...>`：显式把一个进程绑定成某家 agent 的根。

给两类场景用：
  1. 没有 hook、也认不出进程的 agent（自研脚本、`python my_agent.py`、容器里的东西）——注册表的
     comm/argv 特征对不上，探针不知道该跟踪谁；
  2. 想给一次运行一个确定的 session 键，让系统层事件和 hook 事件能对上。

做法（借 agentsight `record -- <cmd>` 的形态）：
  - 解析命令（PATH 查找、符号链接、shebang 脚本 → 解释器），只是为了把真实可执行文件记下来；
  - 在 $CC_MONITOR_HOME/run/<pid>.json 写一条登记 {pid, agent, session, argv, exe}，探针的 /proc
    扫描线程把它当作一个根（3 秒内纳入）；进程退出后登记文件由扫描线程清理；
  - 设置 CC_MONITOR_AGENT / CC_MONITOR_SESSION 环境变量后 exec 目标命令（同一个 pid，不多一层
    父进程）。hook 如果被那家 agent 触发、命令行里又没带 --agent，就从环境变量取 agent。
"""
import json
import os
import shlex
import shutil
import sys
import time
import uuid

from . import registry, storage

RUN_DIR = storage.CONFIG_DIR / "run"


def resolve_binary(command):
    """命令名 → 真实可执行文件路径（PATH、符号链接、`#!/usr/bin/env node` 这种壳脚本的解释器）。
    只用于记录；exec 仍然用原命令，行为跟用户直接敲一样。"""
    path = shutil.which(command) or command
    try:
        path = os.path.realpath(path)
    except OSError:
        return path
    try:
        with open(path, "rb") as f:
            head = f.read(256)
    except OSError:
        return path
    if head.startswith(b"#!"):
        line = head.split(b"\n", 1)[0][2:].decode("utf-8", "replace").strip()
        parts = shlex.split(line)
        if parts and os.path.basename(parts[0]) == "env" and len(parts) > 1:
            interp = parts[1]
        elif parts:
            interp = parts[0]
        else:
            return path
        return resolve_binary(interp)
    return path


def register(pid, agent, session, argv, exe):
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    tmp = RUN_DIR / ("{}.json.tmp".format(pid))
    tmp.write_text(json.dumps({"pid": pid, "agent": agent, "session": session, "argv": argv, "exe": exe,
                               "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z")}, ensure_ascii=False), encoding="utf-8")
    os.replace(str(tmp), str(RUN_DIR / ("{}.json".format(pid))))


def load_registrations():
    """{pid: agent}；进程已经不在的登记顺手删掉。"""
    out = {}
    if not RUN_DIR.is_dir():
        return out
    for path in RUN_DIR.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            pid = int(data["pid"])
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if not os.path.isdir("/proc/{}".format(pid)):
            try:
                path.unlink()
            except OSError:
                pass
            continue
        out[pid] = data.get("agent") or "generic"
    return out


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    agent = None
    if argv and argv[0] in ("--agent",) and len(argv) > 1:
        agent = argv[1]
        argv = argv[2:]
    elif argv and argv[0].startswith("--agent="):
        agent = argv[0].split("=", 1)[1]
        argv = argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        print("用法: CC-Monitor run [--agent <id>] -- <命令> [参数...]", file=sys.stderr)
        sys.exit(2)
    if agent is None:
        agent = registry.classify_process("", " ".join(argv), resolve_binary(argv[0])) or "generic"
    session = str(uuid.uuid4())
    exe = resolve_binary(argv[0])
    register(os.getpid(), agent, session, argv, exe)
    try:
        from . import procscan
        storage.touch_session(agent, session, root_pid=os.getpid(), root_start=procscan.proc_start(os.getpid()), cwd=os.getcwd())
    except Exception:
        pass
    env = dict(os.environ)
    env["CC_MONITOR_AGENT"] = agent
    env["CC_MONITOR_SESSION"] = session
    print("[CC-Monitor] run: agent={} session={} pid={} exe={}".format(agent, session[:8], os.getpid(), exe), file=sys.stderr)
    try:
        os.execvpe(argv[0], argv, env)
    except OSError as exc:
        print("[CC-Monitor] 无法执行 {}: {}".format(argv[0], exc), file=sys.stderr)
        sys.exit(127)


if __name__ == "__main__":
    main()
