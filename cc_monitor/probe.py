"""系统层探针（Linux / eBPF）。

独立于各家 AI agent 的 hooks，用 bpftrace 直接在内核层跟踪从 agent 进程派生出来的
子进程树的 execve/connect。目的：交叉验证应用层 hooks 是否被绕过或篡改——
hooks 是"自证清白"，这里是不依赖 agent 配合的独立观察，因此必须以 root 运行。

谁是 agent 由 Agent 注册表（cc_monitor/agents/*.json）决定，本模块不认识任何一家：
  - 编译型 agent（claude / codex / opencode……）靠 comm 名在内核里直接认；
  - node/python 托管的 agent（Gemini CLI、Aider……）comm 是解释器名，靠 procscan 扫 /proc
    按 argv 认，找到后渲染进 bpftrace 脚本的 BEGIN 块（播种）。探针跑着的时候用户新开了
    一个这样的 agent，扫描线程会发现并重启 bpftrace（重启窗口约 1 秒）。
  - 探针启动时已经在跑的 agent 进程树同样通过播种进入监视集合。

用法: sudo python3 -m cc_monitor.probe   (或 sudo bin/CC-Monitor-probe)
      python3 -m cc_monitor.probe --print-script   # 只打印渲染后的 bpftrace 脚本（不需要 root）
"""
import fnmatch
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from . import colors as col
from . import policy, procscan, registry, storage, workdir

BT_TEMPLATE = Path(__file__).parent / "probe_linux.bt.tmpl"

# 同一条命令在 hook 层和探针层出现的时间差在这个窗口内都算"对得上"。
CORRELATION_WINDOW_SEC = 15
DNS_CACHE_TTL_SEC = 3600
# 扫 /proc 找新根的间隔
RESCAN_INTERVAL_SEC = 3
# 文件级观测：同一 (根进程, 路径, 操作) 在这个窗口内只报第一次，其余累计计数，窗口到期报一条汇总
FILE_AGG_WINDOW_SEC = 60
# 文件级观测的熔断：任一根进程每秒超过这个数就只计数不落库（构建/安装类命令一秒能写几千个文件）
FILE_STORM_PER_SEC = 200
# 路径里含这些目录段的写入不报：构建缓存、版本库内部、包缓存——量大且没有安全含义
FILE_IGNORE_SEGMENTS = (
    ".git", "__pycache__", "node_modules", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox",
    ".venv", "venv", ".cache", "target", "build", "dist", ".next", ".nuxt", ".gradle", ".m2",
    ".npm", ".yarn", ".pnpm-store", ".cargo", ".rustup", "go/pkg", ".terraform",
)
FILE_IGNORE_SUFFIXES = (".pyc", ".pyo", ".o", ".a", ".class", ".swp", ".swo", ".swx", "~", ".tmp", ".part")


def _is_infra_noise(command_text, agent=None):
    return any(p.search(command_text) for p in registry.infra_noise_patterns(agent))


def _reverse_dns(ip, cache={}):
    now = time.time()
    cached = cache.get(ip)
    if cached and now - cached[1] < DNS_CACHE_TTL_SEC:
        return cached[0]
    try:
        host = socket.gethostbyaddr(ip)[0]
    except (socket.herror, socket.gaierror, OSError):
        host = None
    cache[ip] = (host, now)
    return host


def _extract_shell_command(argv_line, agent=None):
    """从 `bash -c '<command>'` 这样的 argv 中把 <command> 抠出来，用于跟 hook 层比对。
    Codex 用 `bash -lc`，其它 agent 用 `-c`，都认。"""
    parts = argv_line.split(None, 1)
    if not parts:
        return None
    prog = parts[0].rsplit("/", 1)[-1]
    if prog not in registry.shell_comms(agent):
        return None
    rest = parts[1] if len(parts) > 1 else ""
    m = re.match(r"^-(?:l?c|cl)\s+(.*)$", rest, re.DOTALL)
    if not m:
        return None
    cmd = m.group(1)
    return None if _is_infra_noise(cmd, agent) else cmd


_QUOTE_CHARS = str.maketrans("", "", "'\"")


def _normalize(text):
    """去掉所有引号字符。

    shell 在把原始命令套进 `eval '<command>'` 包装脚本时，如果命令本身含单引号，
    会转义成 `'"'"'` 这种序列（结束引号、转义一个引号、重新开引号）——纯粹是引号
    记法上的变化，不影响命令的实际内容。比对前把两边的引号都剥掉，就不会被这种
    转义差异搞出假阳性。
    """
    return text.translate(_QUOTE_CHARS)


def _find_matching_hook_command(haystack_text, around_ts_epoch, agent=None):
    """检查最近的 hook_pre Bash 记录里，有没有哪一条的原始命令整段被包含在这次观测到
    的 shell 调用文本里。

    之所以反过来找"hook 记录是不是这段观测文本的子串"，是因为 Claude Code 的 Bash
    工具经常会把用户命令包一层 shell 快照/eval 脚本再执行（比如
    `zsh -c "source snapshot.sh && eval '<原始命令>' < /dev/null && ..."`），
    所以探针看到的 argv 文本通常比 hook 记录的 command 字段更长、包着它。
    只比对同一家 agent 的 hook 记录（agent 为 None 时比对所有）。
    """
    if not haystack_text:
        return True  # 不是可比对的 shell -c 命令（比如 ps/awk 这类子进程），不参与比对
    haystack_norm = _normalize(haystack_text)
    for ts, _agent, hook_cmd in storage.fetch_recent_shell_commands(agent=agent, limit=300):
        try:
            ts_epoch = time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            continue
        if abs(ts_epoch - around_ts_epoch) > CORRELATION_WINDOW_SEC:
            continue
        needle = _normalize(hook_cmd[:80])
        if needle and needle in haystack_norm:
            return True
    return False


_recent_exec_seen = {}
DEDUP_WINDOW_SEC = 1.0


def _already_seen(pid, argv_line, now):
    """短时间内同一个 (pid, argv) 重复出现就跳过——常见于高频轮询类进程
    （比如状态栏刷新）在极短时间内被内核复用了同一个 pid 号。"""
    if len(_recent_exec_seen) > 5000:
        _recent_exec_seen.clear()
    key = (pid, argv_line)
    last = _recent_exec_seen.get(key)
    _recent_exec_seen[key] = now
    return last is not None and now - last < DEDUP_WINDOW_SEC


class RootTable(object):
    """根 pid → agent id。内核层认出来的根（ROOT 行）在这里按 /proc 分类；播种进去的根
    从 procscan 直接带着 agent id。分类不出来的根记成 None（事件照记，agent 留空）。"""

    def __init__(self):
        self.agents = {}
        self.lock = threading.Lock()

    def set(self, root_pid, agent):
        with self.lock:
            self.agents[int(root_pid)] = agent

    def agent_of(self, root_pid):
        try:
            root_pid = int(root_pid)
        except (TypeError, ValueError):
            return None
        with self.lock:
            if root_pid in self.agents:
                return self.agents[root_pid]
        agent = procscan.classify_pid(root_pid)
        with self.lock:
            self.agents[root_pid] = agent
        return agent

    def known(self):
        with self.lock:
            return set(self.agents)


ROOTS = RootTable()

_session_cache = {}  # root_pid -> (session_id, ts)
SESSION_CACHE_TTL_SEC = 10


def _session_for(root, agent=None):
    """根进程 → 会话 id（sessions 表由 hook 进程沿父链登记，见 hook.record_session）。找不到返回空串；
    没找到的也缓存 10 秒，免得每条事件都查一次库。"""
    try:
        root_i = int(root)
    except (TypeError, ValueError):
        return ""
    now = time.time()
    hit = _session_cache.get(root_i)
    if hit and now - hit[1] < SESSION_CACHE_TTL_SEC:
        return hit[0]
    if len(_session_cache) > 2000:
        _session_cache.clear()
    sid = storage.session_for_root(root_i, root_start=procscan.proc_start(root_i), agent=agent) or ""
    _session_cache[root_i] = (sid, now)
    return sid


def _handle_root_line(fields):
    # ROOT \t pid \t uid \t comm
    _tag, pid, uid, comm = fields[:4]
    agent = ROOTS.agent_of(pid)
    _cwd_cache.pop(pid, None)
    _pid_cwd(pid)
    print(col.c("[CC-Monitor][probe] 发现 agent 根进程: pid={} comm={} agent={}".format(
        pid, comm, agent or "?"), color="cyan"))


def _handle_exec_line(fields):
    # EXEC \t pid \t uid \t comm \t root \t argv...
    _tag, pid, uid, comm, root = fields[0], fields[1], fields[2], fields[3], fields[4]
    argv_line = fields[5] if len(fields) > 5 else ""
    now = time.time()

    if _already_seen(pid, argv_line, now):
        return

    agent = ROOTS.agent_of(root)
    # agent 自己的基础设施命令（hook 调用本身、状态栏刷新、终端尺寸探测……）整条不落库：
    # 每次 hook 调用会派生 sh → CC-Monitor-hook → python 三个 exec，Claude Code 的状态栏每几秒
    # 跑一遍 ps/stty，真机库里 68% 的 os_exec 都是这些，没有任何审计价值。
    if _is_infra_noise(argv_line, agent):
        return
    shell_cmd = _extract_shell_command(argv_line, agent)
    if shell_cmd and _is_infra_noise(shell_cmd, agent):
        return
    matched = _find_matching_hook_command(shell_cmd, now, agent=agent)

    rule, matched_value = (None, None)
    if shell_cmd:
        rule, matched_value = policy.evaluate("Bash", {"command": shell_cmd}, agent=agent)

    risk = rule["risk"] if rule else ("high" if not matched else "info")
    note = "命令与 hook 记录对不上，可能绕过了监测" if not matched else None

    storage.log_event(
        session_id=_session_for(root, agent),
        source="os_exec",
        tool_name=comm,
        detail={
            "pid": pid,
            "uid": uid,
            "root_pid": root,
            "agent": agent,
            "argv": argv_line,
            "shell_command": shell_cmd,
            "hook_matched": matched,
            "matched_rule": rule["id"] if rule else None,
            "note": note,
        },
        cwd="",
        risk=risk,
        matched_rule=rule["id"] if rule else ("hook_bypass_suspected" if not matched else None),
        decision="observed",
        agent=agent or storage.DEFAULT_AGENT,
    )
    if not matched:
        msg = "[CC-Monitor][probe] ⚠ 可能绕过监测: agent={} pid={} comm={} 命令未见于 hook 记录: {}".format(
            agent or "?", pid, comm, (shell_cmd or argv_line)[:200]
        )
        print(col.c(msg, color="bright_red", bold=True), file=sys.stderr)
    elif rule:
        msg = "[CC-Monitor][probe] [{}] agent={} pid={} comm={} 命中规则 {}: {}".format(
            risk, agent or "?", pid, comm, rule["id"], shell_cmd[:200]
        )
        print(col.c(msg, color=col.RISK_COLOR.get(risk, "gray"), bold=(risk == "high")))


def _handle_connect_line(fields):
    # CONNECT \t pid \t uid \t comm \t root \t ip \t port \t dns_query_host
    # dns_query_host 来自 uprobe:libc:getaddrinfo 抓到的、这个进程连接前实际问过的
    # 域名（比如 "api.anthropic.com"）——比事后对 IP 做反向 DNS 靠谱得多。反向 DNS
    # 留着当兜底（万一没经过 getaddrinfo，比如直接连 IP 字面量的场景）。
    _tag, pid, uid, comm, root, ip, port, dns_query_host = fields[:8]
    agent = ROOTS.agent_of(root)
    host = dns_query_host or _reverse_dns(ip)
    target = "{} ({})".format(ip, host) if host else ip
    storage.log_event(
        session_id=_session_for(root, agent),
        source="os_net",
        tool_name=comm,
        detail={"pid": pid, "uid": uid, "root_pid": root, "agent": agent, "ip": ip, "port": port, "host": host},
        cwd="",
        risk="info",
        matched_rule=None,
        decision="observed",
        agent=agent or storage.DEFAULT_AGENT,
    )
    storage.record_network_connect(ip, int(port), host)
    msg = "[CC-Monitor][probe] 网络连接: agent={} pid={} comm={} -> {}:{}".format(
        agent or "?", pid, col.c(comm, color="cyan"), col.c(target, color="blue"), port
    )
    print(msg)


# ---- 文件级观测 ----

_cwd_cache = {}  # pid -> 当前目录（CHDIR 事件维护；第一次见到时读 /proc）


def _pid_cwd(pid):
    cwd = _cwd_cache.get(pid)
    if cwd:
        return cwd
    if len(_cwd_cache) > 5000:
        _cwd_cache.clear()
    try:
        cwd = os.readlink("/proc/{}/cwd".format(pid))
    except OSError:
        cwd = "/"
    _cwd_cache[pid] = cwd
    return cwd


AT_FDCWD = -100
_dirfds = {}  # (pid, fd) -> 目录绝对路径（OPENDIR 事件维护）


def _dirfd_path(pid, dirfd):
    base = _dirfds.get((pid, str(dirfd)))
    if base:
        return base
    try:
        return os.readlink("/proc/{}/fd/{}".format(pid, dirfd))
    except OSError:
        return None


def _resolve_path(pid, raw, dirfd=AT_FDCWD):
    """相对路径：dirfd 是 AT_FDCWD 就相对于进程当前目录；否则（`rm -r` / `mkdir -p` 这类工具
    用 openat 拿着目录 fd 逐级操作）相对于那个 fd 指向的目录——优先查 OPENDIR 事件建的表，
    没有再试 /proc/<pid>/fd/<n>（进程可能已经退出），都拿不到退回当前目录。"""
    raw = raw or ""
    if not raw:
        return ""
    if not raw.startswith("/"):
        base = _dirfd_path(pid, dirfd) if dirfd != AT_FDCWD else None
        raw = os.path.join(base or _pid_cwd(pid), raw)
    return os.path.normpath(raw)


def _handle_opendir_line(fields):
    # OPENDIR \t pid \t uid \t comm \t root \t fd \t path \t dfd
    pid, fd, raw, dfd = fields[1], fields[5], fields[6] if len(fields) > 6 else "", fields[7] if len(fields) > 7 else ""
    try:
        dfd_i = int(dfd) if dfd else AT_FDCWD
    except ValueError:
        dfd_i = AT_FDCWD
    if len(_dirfds) > 20000:
        _dirfds.clear()
    _dirfds[(pid, fd)] = _resolve_path(pid, raw, dfd_i)


def _handle_dup_line(fields):
    # DUP \t pid \t uid \t comm \t root \t oldfd \t newfd
    pid, old, new = fields[1], fields[5], fields[6] if len(fields) > 6 else ""
    path = _dirfds.get((pid, old))
    if path and new:
        _dirfds[(pid, new)] = path


def _handle_fchdir_line(fields):
    # FCHDIR \t pid \t uid \t comm \t root \t fd
    pid, fd = fields[1], fields[5] if len(fields) > 5 else ""
    base = _dirfd_path(pid, fd)
    if base:
        _cwd_cache[pid] = base


def _ignored_roots_cached(cache={}):
    """探针侧的排除前缀：workdir 的临时目录 + 各 agent 的状态目录（对所有可能的家目录）+
    CC-Monitor 自己的数据目录 + 系统只读目录。启动时算一次。"""
    if cache:
        return cache["roots"]
    homes = ["/root"] + [d for parent in ("/home", "/Users") if os.path.isdir(parent)
                         for d in (os.path.join(parent, n) for n in os.listdir(parent))]
    roots = set(workdir.DEFAULT_IGNORE) | {"/proc", "/sys", "/dev", "/run", "/var/cache", "/var/lib/apt", "/var/lib/dpkg",
                                           "/usr/lib", "/usr/lib64", "/usr/libexec", "/lib", "/lib64", "/usr/share",
                                           str(storage.CONFIG_DIR)}
    tmpdir = os.environ.get("TMPDIR")
    if tmpdir:
        roots.add(os.path.normpath(tmpdir))
    for home in homes:
        for rel in registry.home_ignore() + registry.state_dirs() + workdir.HOME_READ_QUIET:
            roots.add(os.path.join(home, rel))
        roots.add(os.path.join(home, ".cc-monitor"))
    cache["roots"] = tuple(sorted(roots))
    return cache["roots"]


def _under_root(path, root):
    """root 以 * 结尾是前缀匹配（~/.claude.json* 盖住 .claude.json、.claude.json.tmp.<pid>.<hash>、
    .claude.json.backup……），否则是目录/文件精确匹配。"""
    if root.endswith("*"):
        return path.startswith(root[:-1])
    return path == root or path.startswith(root.rstrip("/") + "/")


def _is_agent_state_path(path, agent):
    """agent 进程自己写自己的状态目录（~/.claude/…、~/.codex/…）——正常维护，不是绕过 hook。"""
    for home in ("/root",) + tuple(os.path.join(p, n) for p in ("/home", "/Users") if os.path.isdir(p) for n in os.listdir(p)):
        for rel in registry.state_dirs(agent) or registry.state_dirs():
            if _under_root(path, os.path.join(home, rel)):
                return True
    return False


def _file_ignored(path):
    if not path:
        return True
    for root in _ignored_roots_cached():
        if _under_root(path, root):
            return True
    for g in registry.file_ignore_globs():
        if fnmatch.fnmatch(path, g):
            return True
    parts = path.split("/")
    if any(seg in FILE_IGNORE_SEGMENTS for seg in parts[:-1]):
        return True
    base = parts[-1]
    if base.endswith(FILE_IGNORE_SUFFIXES) or base.startswith(".#"):
        return True
    return False


class _FileAggregator(object):
    """(根 pid, 路径, 操作) 的 60 秒滑动窗口：第一次立刻报，窗口内重复只计数，到期报汇总。
    另有每秒熔断：一个根进程一秒内文件事件超过 FILE_STORM_PER_SEC 就只计数不落库。"""

    def __init__(self):
        self.windows = {}   # key -> [first_ts, count, agent, comm, pid, uid]
        self.storm = {}     # root -> [sec, count, dropped]

    def storm_check(self, root, now):
        sec = int(now)
        st = self.storm.setdefault(root, [sec, 0, 0])
        if st[0] != sec:
            if st[2]:
                storage.log_event(
                    session_id="", source="os_file", tool_name="probe",
                    detail={"root_pid": root, "agent": ROOTS.agent_of(root), "op": "storm",
                            "note": "文件事件过多，{} 秒内丢弃 {} 条未落库".format(1, st[2]), "dropped": st[2]},
                    cwd="", risk="info", matched_rule=None, decision="observed",
                    agent=ROOTS.agent_of(root) or storage.DEFAULT_AGENT,
                )
            st[0], st[1], st[2] = sec, 0, 0
        st[1] += 1
        if st[1] > FILE_STORM_PER_SEC:
            st[2] += 1
            return False
        return True

    def hit(self, key, now, meta):
        """返回 True 表示这次要落库（首次），False 表示已计入聚合。"""
        w = self.windows.get(key)
        if w and now - w[0] < FILE_AGG_WINDOW_SEC:
            w[1] += 1
            return False
        if w:
            self._flush_one(key, w, now)
        self.windows[key] = [now, 1] + list(meta)
        return True

    def flush_expired(self, now):
        for key, w in list(self.windows.items()):
            if now - w[0] >= FILE_AGG_WINDOW_SEC:
                self._flush_one(key, w, now)
                del self.windows[key]

    def _flush_one(self, key, w, now):
        root, path, op = key
        first_ts, count, agent, comm, pid, uid = w
        if count <= 1:
            return
        storage.log_event(
            session_id=_session_for(root, agent), source="os_file", tool_name=comm,
            detail={"pid": pid, "uid": uid, "root_pid": root, "agent": agent, "op": op, "path": path,
                    "count": count, "window_sec": FILE_AGG_WINDOW_SEC, "aggregated": True},
            cwd="", risk="info", matched_rule=None, decision="observed",
            agent=agent or storage.DEFAULT_AGENT,
        )


FILES = _FileAggregator()
FILE_TOOL_BY_OP = {"write": "Write", "unlink": "Write", "rename": "Write", "mkdir": "Write"}


def _find_matching_hook_write(path, around_ts_epoch, agent=None):
    """agent 进程自己写了 path：hook 层 15 秒内应有 Write/Edit 类记录指向同一个文件。"""
    for ts, _agent, hook_path in storage.fetch_recent_file_writes(agent=agent, limit=300):
        try:
            ts_epoch = time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            continue
        if abs(ts_epoch - around_ts_epoch) > CORRELATION_WINDOW_SEC:
            continue
        if os.path.normpath(os.path.expanduser(hook_path)) == path:
            return True
    return False


def _handle_fork_line(fields):
    # FORK \t parent \t child ：子进程继承父进程的当前目录和已打开的目录句柄
    parent, child = fields[1], fields[2]
    cwd = _cwd_cache.get(parent)
    if cwd:
        _cwd_cache[child] = cwd
    for (p, fd), path in list(_dirfds.items()):
        if p == parent:
            _dirfds[(child, fd)] = path


def _handle_chdir_line(fields):
    # CHDIR \t pid \t uid \t comm \t root \t path
    pid, path = fields[1], fields[5] if len(fields) > 5 else ""
    _cwd_cache[pid] = _resolve_path(pid, path)


def _handle_file_line(fields):
    # FILE \t pid \t uid \t comm \t root \t op \t flags \t path \t path2 \t dirfd
    _tag, pid, uid, comm, root, op = fields[:6]
    flags = fields[6] if len(fields) > 6 else ""
    raw_path = fields[7] if len(fields) > 7 else ""
    raw_path2 = fields[8] if len(fields) > 8 else ""
    try:
        dirfd = int(fields[9]) if len(fields) > 9 and fields[9] else AT_FDCWD
    except ValueError:
        dirfd = AT_FDCWD
    now = time.time()
    if not FILES.storm_check(root, now):
        return
    path = _resolve_path(pid, raw_path, dirfd)
    path2 = _resolve_path(pid, raw_path2, dirfd) if raw_path2 else None
    target = path2 or path  # rename 看目标；其它看路径本身
    if _file_ignored(target) and (not path2 or _file_ignored(path)):
        return
    agent = ROOTS.agent_of(root)
    if not FILES.hit((root, target, op), now, (agent, comm, pid, uid)):
        return

    # 规则：文件路径类规则（写 SSH 密钥、改 agent 配置……）对内核层看到的写入同样生效，
    # 哪怕是 agent 派生的子进程（pip/npm/脚本）写的。cwd 给根进程的，让越界规则也能判。
    rule, matched_value = policy.evaluate(FILE_TOOL_BY_OP.get(op, "Write"), {"file_path": target},
                                          cwd=_pid_cwd(root), agent=agent)
    is_self = str(pid) == str(root)
    state_path = is_self and _is_agent_state_path(target, agent)
    hook_matched = None
    if is_self and not state_path and op in ("write", "rename"):
        # agent 进程自己（不是它派生的子进程）直接写文件 = 走的是 Write/Edit 工具，hook 层必须有记录
        hook_matched = _find_matching_hook_write(target, now, agent=agent)
    bypass = hook_matched is False
    risk = rule["risk"] if rule else ("high" if bypass else "info")
    note = "agent 进程直接写入文件但 hook 层没有对应的 Write/Edit 记录，可能绕过了监测" if bypass else None
    storage.log_event(
        session_id=_session_for(root, agent), source="os_file", tool_name=comm,
        detail={"pid": pid, "uid": uid, "root_pid": root, "agent": agent, "op": op, "flags": flags,
                "path": path, "path2": path2, "by_agent_process": is_self, "agent_state": state_path,
                "hook_matched": hook_matched, "matched_rule": rule["id"] if rule else None,
                "matched_value": matched_value, "note": note},
        cwd="", risk=risk,
        matched_rule=rule["id"] if rule else ("hook_bypass_suspected" if bypass else None),
        decision="observed", agent=agent or storage.DEFAULT_AGENT,
    )
    if bypass:
        print(col.c("[CC-Monitor][probe] ⚠ 可能绕过监测: agent={} pid={} 直接写入 {} 但无对应 hook 记录".format(
            agent or "?", pid, target), color="bright_red", bold=True), file=sys.stderr)
    elif rule:
        print(col.c("[CC-Monitor][probe] [{}] agent={} pid={} comm={} 文件{} {} 命中规则 {}".format(
            risk, agent or "?", pid, comm, op, target, rule["id"]), color=col.RISK_COLOR.get(risk, "gray"), bold=(risk == "high")))


# ---- 监听端口 ----

_binds = {}  # (pid, fd) -> (ip, port, ts)


def _handle_bind_line(fields):
    # BIND \t pid \t uid \t comm \t root \t fd \t ip \t port
    _tag, pid, uid, comm, root, fd, ip, port = fields[:8]
    _binds[(pid, fd)] = (ip, port, time.time())
    if len(_binds) > 5000:
        _binds.clear()


def _handle_listen_line(fields):
    # LISTEN \t pid \t uid \t comm \t root \t fd
    _tag, pid, uid, comm, root, fd = fields[:6]
    bound = _binds.pop((pid, fd), None)
    if not bound:
        return  # 没看到 bind（unix socket、或探针启动前就 bind 了）：报不出端口，不记
    ip, port, _ts = bound
    agent = ROOTS.agent_of(root)
    exposed = ip in ("0.0.0.0", "::")
    storage.log_event(
        session_id=_session_for(root, agent), source="os_listen", tool_name=comm,
        detail={"pid": pid, "uid": uid, "root_pid": root, "agent": agent, "ip": ip, "port": port,
                "exposed": exposed,
                "note": "监听在所有网卡上，局域网/公网可达" if exposed else None},
        cwd="", risk="medium" if exposed else "low", matched_rule="listen_exposed" if exposed else None,
        decision="observed", agent=agent or storage.DEFAULT_AGENT,
    )
    print(col.c("[CC-Monitor][probe] 开始监听: agent={} pid={} comm={} {}:{}{}".format(
        agent or "?", pid, comm, ip, port, "  ⚠ 对外暴露" if exposed else ""),
        color="yellow" if exposed else None))


# bpftrace 打印聚合 map 用的是自己的默认格式，不是我们自己拼的 tag\t字段 这一套，
# 得单独用正则认——比如 `@tx_bytes[160.79.104.10, 443]: 725`。
_BYTES_MAP_LINE = re.compile(r"^@(tx_bytes|rx_bytes)\[([^,]+), (\d+)\]: (\d+)$")


def _handle_bytes_line(line):
    m = _BYTES_MAP_LINE.match(line)
    if not m:
        return False
    direction, ip, port, num_bytes = m.groups()
    tx = int(num_bytes) if direction == "tx_bytes" else 0
    rx = int(num_bytes) if direction == "rx_bytes" else 0
    storage.record_network_bytes(ip, int(port), tx_bytes=tx, rx_bytes=rx)
    return True


# ---- 脚本渲染 ----

def render_script(seed=None, template_text=None):
    """把模板渲染成可执行的 bpftrace 脚本。seed 是 {pid: (root_pid, agent_id)}。"""
    text = template_text if template_text is not None else BT_TEMPLATE.read_text(encoding="utf-8")
    root_comms = {}
    for _pid, (root, _aid) in (seed or {}).items():
        if root not in root_comms:
            try:
                root_comms[root] = open("/proc/{}/comm".format(root)).read().strip()
            except OSError:
                pass
    return (text
            .replace("__CC_ROOT_COMM_PREDICATE__", procscan.comm_predicate())
            .replace("__CC_SEED__", procscan.seed_block(seed or {}, root_comms)))


def _backfill_sessions(seed):
    """探针启动时已经在跑的 agent 根进程：它的会话可能早就有 hook 记录（sessions 表里有行）但
    没有 root_pid（那时探针还没起来，hook 登记的是父链，其实一直有……除非是老库升级）。按
    agent + cwd + 最近活跃 反推一个，标 evidence=cwd_recent，之后 hook 一来就会被精确证据覆盖。"""
    for root, agent in sorted({(r, a) for (r, a) in seed.values()}):
        try:
            if storage.session_for_root(root, root_start=procscan.proc_start(root)):
                continue
            sid = storage.backfill_session_root(agent, _pid_cwd(root), root, procscan.proc_start(root))
            if sid:
                print(col.c("[CC-Monitor][probe] 会话反推: pid={} {} ← {}（按 cwd 猜的，hook 事件到来后会校正）".format(
                    root, agent, sid[:12]), dim=True))
        except Exception:
            continue


def _write_script(seed):
    for pid, (root, agent) in seed.items():
        ROOTS.set(root, agent)
        _pid_cwd(pid)  # 播种的进程还活着，现在就把 cwd 读进缓存
    _backfill_sessions(seed)
    fd, path = tempfile.mkstemp(prefix="cc-monitor-probe-", suffix=".bt")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(render_script(seed))
    return path


# ---- 主循环 ----

class _Rescanner(threading.Thread):
    """后台扫 /proc：发现内核层认不出的新根（node/python 托管的 agent）就置位，主循环重启 bpftrace。"""

    def __init__(self):
        super().__init__(daemon=True)
        self.new_roots = {}
        self.event = threading.Event()
        self.stop = threading.Event()

    def run(self):
        while not self.stop.wait(RESCAN_INTERVAL_SEC):
            try:
                roots = procscan.find_roots()
            except OSError:
                continue
            known = ROOTS.known()
            fresh = {pid: aid for pid, aid in roots.items() if pid not in known}
            if fresh:
                self.new_roots.update(fresh)
                self.event.set()


def _spawn(seed):
    script = _write_script(seed)
    proc = subprocess.Popen(
        ["bpftrace", script],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    return proc, script


def run():
    if "--print-script" in sys.argv:
        print(render_script(procscan.seed_map()))
        return
    if shutil.which("bpftrace") is None:
        print(
            "错误: 未找到 bpftrace，请先安装（如 Debian/Ubuntu: apt install bpftrace）。"
            "这个探针依赖 Linux 内核的 eBPF 子系统，macOS 上没有等价物，装不了也跑不起来。",
            file=sys.stderr,
        )
        sys.exit(1)
    if not BT_TEMPLATE.exists():
        print("错误: 找不到探针模板 {}".format(BT_TEMPLATE), file=sys.stderr)
        sys.exit(1)

    names = ", ".join(registry.display_name(a) for a in registry.ids())
    print(col.c("[CC-Monitor][probe] 启动系统层探针 (bpftrace)，跟踪 agent 进程树的 exec/connect: {}".format(names), color="cyan"))

    rescanner = _Rescanner()
    rescanner.start()
    seed = procscan.seed_map()
    if seed:
        roots = sorted({(r, a) for (r, a) in seed.values()})
        print(col.c("[CC-Monitor][probe] 播种已在运行的 agent: {}".format(
            ", ".join("pid={} {}".format(r, a) for r, a in roots)), color="cyan"))
    try:
        while True:
            proc, script = _spawn(seed)
            try:
                _pump(proc, rescanner)
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                try:
                    os.unlink(script)
                except OSError:
                    pass
            if not rescanner.event.is_set():
                break  # bpftrace 自己退出了（出错），不再重启
            rescanner.event.clear()
            fresh = dict(rescanner.new_roots)
            rescanner.new_roots.clear()
            print(col.c("[CC-Monitor][probe] 发现新的 agent 根进程 {}，重启探针以纳入监视".format(
                ", ".join("pid={} {}".format(p, a) for p, a in fresh.items())), color="yellow"))
            seed = procscan.seed_map()  # 重新扫一遍：老根的后代 + 新根的后代一起播种
    except KeyboardInterrupt:
        pass
    finally:
        rescanner.stop.set()


def _pump(proc, rescanner):
    """读 bpftrace 输出直到它退出，或者扫描线程要求重启。"""
    known_tags = {"READY", "ROOT", "EXEC", "CONNECT", "FILE", "CHDIR", "BIND", "LISTEN", "FORK", "OPENDIR", "FCHDIR", "DUP"}
    pending = None  # 正在组装的一条记录（字段列表），最后一个字段可能横跨多行

    def flush(rec):
        if not rec:
            return
        try:
            if rec[0] == "READY":
                print(col.c("[CC-Monitor][probe] 就绪", color="green"))
            elif rec[0] == "ROOT":
                _handle_root_line(rec)
            elif rec[0] == "EXEC":
                _handle_exec_line(rec)
            elif rec[0] == "CONNECT":
                _handle_connect_line(rec)
            elif rec[0] == "FILE":
                _handle_file_line(rec)
            elif rec[0] == "CHDIR":
                _handle_chdir_line(rec)
            elif rec[0] == "FORK":
                _handle_fork_line(rec)
            elif rec[0] == "OPENDIR":
                _handle_opendir_line(rec)
            elif rec[0] == "FCHDIR":
                _handle_fchdir_line(rec)
            elif rec[0] == "DUP":
                _handle_dup_line(rec)
            elif rec[0] == "BIND":
                _handle_bind_line(rec)
            elif rec[0] == "LISTEN":
                _handle_listen_line(rec)
        except Exception as exc:  # 探针本身绝不能因为单条解析失败而退出
            msg = "[CC-Monitor][probe] 解析事件出错: {} (记录: {})".format(exc, rec)
            print(col.c(msg, color="yellow"), file=sys.stderr)

    # 用 select 而不是 for line in proc.stdout，这样扫描线程要求重启时不用等下一行输出
    import select
    buf = ""
    last_flush = time.time()
    while True:
        if rescanner.event.is_set():
            flush(pending)
            return
        now = time.time()
        if now - last_flush >= 2:
            FILES.flush_expired(now)
            last_flush = now
        r, _, _ = select.select([proc.stdout], [], [], 0.5)
        if not r:
            if proc.poll() is not None:
                flush(pending)
                return
            continue
        chunk = os.read(proc.stdout.fileno(), 65536).decode("utf-8", "replace")
        if not chunk:
            flush(pending)
            return
        buf += chunk
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            if not line or line.startswith("Attaching"):
                continue
            # @tx_bytes[...]/@rx_bytes[...] 是 bpftrace 自己 print() 一个 map 时的默认格式，
            # 没有 \t——必须在按 \t 切分、判断多行续接之前先认出来单独处理，不然会被误当成
            # 正在组装的上一条 EXEC 记录的续行。
            if _handle_bytes_line(line):
                continue
            fields = line.split("\t")
            if fields[0] in known_tags:
                flush(pending)
                pending = fields
            elif pending is not None:
                # 命令本身带换行（比如多行脚本），bpftrace 会原样打印出来，
                # 这里把它接回上一条记录的最后一个字段（argv），而不是当成新记录丢掉。
                pending[-1] = pending[-1] + "\n" + line


if __name__ == "__main__":
    run()
