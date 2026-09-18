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
    roots = {}
    for pid, p in procs.items():
        aid = registrations.get(pid) or registry.classify_process(p["comm"], p["argv"], p["exe"])
        if aid:
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


def seed_block(seed):
    """BEGIN 块里的播种语句。"""
    lines = []
    for pid, (root, _aid) in sorted(seed.items()):
        lines.append("    @watch[{}] = 1; @root[{}] = {};".format(pid, pid, root))
    return "\n".join(lines)
