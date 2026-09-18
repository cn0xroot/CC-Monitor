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
from . import policy, procscan, registry, storage

BT_TEMPLATE = Path(__file__).parent / "probe_linux.bt.tmpl"

# 同一条命令在 hook 层和探针层出现的时间差在这个窗口内都算"对得上"。
CORRELATION_WINDOW_SEC = 15
DNS_CACHE_TTL_SEC = 3600
# 扫 /proc 找新根的间隔
RESCAN_INTERVAL_SEC = 3


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


def _handle_root_line(fields):
    # ROOT \t pid \t uid \t comm
    _tag, pid, uid, comm = fields[:4]
    agent = ROOTS.agent_of(pid)
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
    shell_cmd = _extract_shell_command(argv_line, agent)
    matched = _find_matching_hook_command(shell_cmd, now, agent=agent)

    rule, matched_value = (None, None)
    if shell_cmd:
        rule, matched_value = policy.evaluate("Bash", {"command": shell_cmd}, agent=agent)

    risk = rule["risk"] if rule else ("high" if not matched else "info")
    note = "命令与 hook 记录对不上，可能绕过了监测" if not matched else None

    storage.log_event(
        session_id="",
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
        session_id="",
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
    return (text
            .replace("__CC_ROOT_COMM_PREDICATE__", procscan.comm_predicate())
            .replace("__CC_SEED__", procscan.seed_block(seed or {})))


def _write_script(seed):
    for _pid, (root, agent) in seed.items():
        ROOTS.set(root, agent)
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
    known_tags = {"READY", "ROOT", "EXEC", "CONNECT"}
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
        except Exception as exc:  # 探针本身绝不能因为单条解析失败而退出
            msg = "[CC-Monitor][probe] 解析事件出错: {} (记录: {})".format(exc, rec)
            print(col.c(msg, color="yellow"), file=sys.stderr)

    # 用 select 而不是 for line in proc.stdout，这样扫描线程要求重启时不用等下一行输出
    import select
    buf = ""
    while True:
        if rescanner.event.is_set():
            flush(pending)
            return
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
