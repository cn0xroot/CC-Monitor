"""/proc 扫描器：在用户态找出本机正在跑的 AI agent 根进程及其整棵子进程树。

两个用途：
  1. 探针启动时"播种"——把已经在跑的 agent 进程树塞进 bpftrace 的 @watch/@root map，不用等
     它们再 exec 一次才被认出来；
  2. 运行中发现内核层认不出来的根——node/python 托管的 agent（Gemini CLI、Aider……）comm 是
     解释器名，只有 argv 能认，探针每隔几秒扫一次，发现新根就重新渲染并重启 bpftrace。

只读 /proc，不需要 root（别的用户的进程 cmdline/exe 读不到时按空处理，comm 还是能读）。
"""
import os
import re

from . import registry

PROC = "/proc"


def _read(path, default=""):
    try:
        with open(path, "rb") as f:
            return f.read().decode("utf-8", "replace")
    except OSError:
        return default


def _stat_fields(pid):
    """/proc/<pid>/stat 里 comm 带括号且可能含空格，先按最后一个 ')' 切。返回 (ppid, starttime_ticks)。"""
    raw = _read("{}/{}/stat".format(PROC, pid))
    if not raw:
        return None, None
    try:
        rest = raw[raw.rindex(")") + 2:].split()
        return int(rest[1]), int(rest[19])
    except (ValueError, IndexError):
        return None, None


def snapshot():
    """所有进程的 {pid: {"ppid", "comm", "argv", "exe", "uid", "starttime"}}。"""
    procs = {}
    for name in os.listdir(PROC):
        if not name.isdigit():
            continue
        pid = int(name)
        ppid, start = _stat_fields(pid)
        if ppid is None:
            continue
        comm = _read("{}/{}/comm".format(PROC, pid)).strip()
        argv = _read("{}/{}/cmdline".format(PROC, pid)).replace("\0", " ").strip()
        try:
            exe = os.readlink("{}/{}/exe".format(PROC, pid))
        except OSError:
            exe = ""
        uid = None
        for line in _read("{}/{}/status".format(PROC, pid)).splitlines():
            if line.startswith("Uid:"):
                try:
                    uid = int(line.split()[1])
                except (ValueError, IndexError):
                    pass
                break
        procs[pid] = {"ppid": ppid, "comm": comm, "argv": argv, "exe": exe, "uid": uid, "starttime": start}
    return procs


def find_roots(procs=None, registrations=None):
    """返回 {root_pid: agent_id}：所有能认出来的 agent 进程都是根，包括跑在另一个 agent 里面的
    （在 Claude Code 的终端里启动 agy，agy 就是自己的根）。它的 hook 事件按自己的 --agent 记，
    系统层事件也归到它名下，交叉验证才对得上。registrations 是 `CC-Monitor run --` 显式登记的
    {pid: agent}，优先于按特征识别（用户说它是什么就是什么）。"""
    procs = procs if procs is not None else snapshot()
    if registrations is None:
        from . import run as _run
        registrations = _run.load_registrations()
    candidates = {}
    for pid, p in procs.items():
        aid = registrations.get(pid) or registry.classify_process(p["comm"], p["argv"], p["exe"])
        if aid:
            candidates[pid] = aid
    # 同一家 agent 的"子 agent 进程"不是根：Antigravity 每跑一个工具/hook 会 fork 一个短命的 agy 子进程，
    # Claude Code 的子代理也是 claude 进程——它们的事件要归到最外层那个同类祖先（真正的会话进程），
    # 否则会话登记到一个几秒就退出的 pid 上，Web UI 立刻判成"已结束"、心跳拉直线。不同家的嵌套
    # （在 claude 里跑 agy）仍然各是各的根。显式登记的 pid 永远是根。
    roots = {}
    for pid, aid in candidates.items():
        if pid in registrations:
            roots[pid] = aid
            continue
        anc = procs.get(pid, {}).get("ppid")
        hops = 0
        shadowed = False
        while anc and anc > 1 and hops < 128:
            if anc in candidates:
                shadowed = candidates[anc] == aid
                break
            anc = procs.get(anc, {}).get("ppid")
            hops += 1
        if not shadowed:
            roots[pid] = aid
    return roots


def descendants(root_pid, procs):
    """root 的全部后代 pid（不含 root 自己），BFS。"""
    children = {}
    for pid, p in procs.items():
        children.setdefault(p["ppid"], []).append(pid)
    out = []
    queue = [root_pid]
    while queue:
        cur = queue.pop(0)
        for c in children.get(cur, []):
            out.append(c)
            queue.append(c)
    return out


def seed_map(procs=None, registrations=None):
    """{pid: (root_pid, agent_id)}——每个 agent 根及其所有后代。渲染进 bpftrace 的 BEGIN 块。
    嵌套时后代归最近的那个 agent 祖先（agy 跑在 claude 里：agy 的子进程归 agy，claude 的其它
    子进程归 claude）。"""
    procs = procs if procs is not None else snapshot()
    roots = find_roots(procs, registrations)
    out = {}
    for pid in procs:
        anc = pid
        hops = 0
        while anc and anc > 1 and hops < 128:
            if anc in roots:
                out[pid] = (anc, roots[anc])
                break
            anc = procs.get(anc, {}).get("ppid")
            hops += 1
    return out


def classify_pid(pid):
    """给一个刚在内核层冒出来的根 pid 判断是哪家 agent（读它的 comm/argv/exe）。"""
    comm = _read("{}/{}/comm".format(PROC, pid)).strip()
    argv = _read("{}/{}/cmdline".format(PROC, pid)).replace("\0", " ").strip()
    try:
        exe = os.readlink("{}/{}/exe".format(PROC, pid))
    except OSError:
        exe = ""
    return registry.classify_process(comm, argv, exe)


def _proc_info(pid):
    """(ppid, starttime, comm, argv, exe)；读不到返回 None。"""
    ppid, start = _stat_fields(pid)
    if ppid is None:
        return None
    comm = _read("{}/{}/comm".format(PROC, pid)).strip()
    argv = _read("{}/{}/cmdline".format(PROC, pid)).replace("\0", " ").strip()
    try:
        exe = os.readlink("{}/{}/exe".format(PROC, pid))
    except OSError:
        exe = ""
    return ppid, start, comm, argv, exe


def _ps_snapshot():
    """macOS 没有 /proc：一次 ps 拿全表 {pid: (ppid, comm, args)}。starttime 拿不到，返回 None。"""
    import subprocess
    try:
        out = subprocess.run(["ps", "-axo", "pid=,ppid=,comm=,args="], capture_output=True, text=True,
                             timeout=5, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    procs = {}
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 3:
            continue
        try:
            procs[int(parts[0])] = (int(parts[1]), parts[2].rsplit("/", 1)[-1], parts[3] if len(parts) > 3 else "")
        except ValueError:
            continue
    return procs


def find_agent_ancestor(pid, registrations=None, max_hops=32, procs=None):
    """从 pid 往上找最近的 agent 根进程：返回 (root_pid, root_start, agent_id)，找不到 (None, None, None)。
    hook 进程调用时 pid 是它自己的父进程：Claude Code 的 hook 命令经 `sh -c` 起，父是 sh、祖父是
    claude；Antigravity 类似。显式登记（CC-Monitor run --）的 pid 优先。"""
    if registrations is None:
        try:
            from . import run as _run
            registrations = _run.load_registrations()
        except Exception:
            registrations = {}
    # 找到最近的 agent 祖先后继续往上走：只要再往上还是同一家 agent，就用更上面的那个（Antigravity
    # 每个工具调用 fork 一个短命 agy 子进程来跑 hook，Claude Code 的子代理也是 claude 进程——会话
    # 的根是最外层那个）。碰到别家 agent 或者链断了就停。显式登记的 pid 直接算根。
    found = None  # (pid, start, agent)

    def consider(cur, start, aid):
        nonlocal found
        if cur in registrations:
            found = (cur, start, registrations[cur])
            return "stop"
        if aid is None:
            return "continue" if found is None else "continue"
        if found is None or found[2] == aid:
            found = (cur, start, aid)
            return "continue"
        return "stop"  # 别家 agent：到此为止

    if procs is None and os.path.isdir(PROC):
        cur = pid
        for _ in range(max_hops):
            if not cur or cur <= 1:
                break
            info = _proc_info(cur)
            if info is None:
                break
            ppid, start, comm, argv, exe = info
            aid = registrations.get(cur) or registry.classify_process(comm, argv, exe)
            if consider(cur, start, aid) == "stop":
                break
            cur = ppid
        return found if found else (None, None, None)
    procs = procs if procs is not None else _ps_snapshot()
    cur = pid
    for _ in range(max_hops):
        info = procs.get(cur)
        if not info or cur <= 1:
            break
        ppid, comm, argv = info
        aid = registrations.get(cur) or registry.classify_process(comm, argv, None)
        if consider(cur, None, aid) == "stop":
            break
        cur = ppid
    return found if found else (None, None, None)


def proc_start(pid):
    """/proc/<pid>/stat 的 starttime（jiffies）；拿不到返回 None。"""
    _ppid, start = _stat_fields(pid)
    return start


_SAFE_COMM = re.compile(r"^[A-Za-z0-9._+-]{1,15}$")


def comm_predicate():
    """渲染进模板的 bpftrace 条件表达式：所有注册 agent 的 comm 精确名 / 前缀。
    comm 名只允许安全字符（它们要被拼进 bpftrace 源码里）。没有任何 agent 时给一个恒假条件。"""
    parts = []
    for comm, _aid in registry.root_comms():
        if _SAFE_COMM.match(comm):
            parts.append('comm == "{}"'.format(comm))
    for prefix, _aid in registry.root_comm_prefixes():
        if _SAFE_COMM.match(prefix):
            parts.append('strncmp(comm, "{}", {}) == 0'.format(prefix, len(prefix)))
    return " || ".join(parts) if parts else "0"


def seed_block(seed, root_comms=None):
    """BEGIN 块里的播种语句。root_comms 是 {root_pid: comm}，给 @rcomm 用（同名子进程不再重新登记为根）。"""
    lines = []
    for pid, (root, _aid) in sorted(seed.items()):
        lines.append("    @watch[{}] = 1; @root[{}] = {};".format(pid, pid, root))
    for root, comm in sorted((root_comms or {}).items()):
        if _SAFE_COMM.match(comm or ""):
            lines.append('    @rcomm[{}] = "{}";'.format(root, comm))
    return "\n".join(lines)
