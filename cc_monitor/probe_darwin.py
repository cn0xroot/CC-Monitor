"""系统层探针（macOS / nettop）。

Linux 那份探针（probe.py）靠 bpftrace/eBPF 在内核层看 execve/connect，macOS 没有这套
东西（Endpoint Security Framework 需要签名的 system extension，见 DESIGN.md 里的规划）。
这里用 Apple 自带的 `nettop`（/usr/bin/nettop，不需要 root）做一个只覆盖**网络**部分
的探针：每 2 秒采一次样，把属于 claude 进程树（claude 本身 + 它派生出来的 bash/curl/
node/python...）的每条连接的远端 IP:port 和上传/下载字节数增量写进跟 Linux 探针同一张
network_traffic 表、同一种 source='os_net' 事件——Web UI 的网络流量页/世界地图/AI 轨迹
不用区分平台。

跟 Linux 探针相比少的东西（都是 nettop 拿不到的）：
- 不看 execve，所以 `CC-Monitor verify` 那套"hook 层和探针层比对、发现绕过"的交叉验证
  在 macOS 上没有；
- 没有 getaddrinfo 的域名捕获，域名只能靠反向 DNS 兜底（很多 CDN/云厂商出口 IP 没有
  PTR 记录，查不到就是空）；
- 只看得到"进程发起了到哪的连接"——如果 Claude Code 配了 HTTPS_PROXY 走本地代理，
  这里看到的远端就是 127.0.0.1:<代理端口>，真正的目标在代理进程那边，跟 Linux 探针
  一样都看不穿。

用法: python3 -m cc_monitor.probe_darwin   (或 bin/CC-Monitor-probe，不需要 sudo)
"""
import re
import shutil
import signal
import subprocess
import sys

from . import colors as col
from . import registry
from . import storage
from .probe import _reverse_dns

SAMPLE_INTERVAL_SEC = 2

# nettop -L 的 CSV：每个采样以表头行开头，然后是"进程行"（<名字>.<pid>,in,out,），
# 每个进程行下面跟着它的连接行（<proto> <本端><-><远端>,in,out,）。表头行的名字列是空的。
_HEADER_RE = re.compile(r"^,bytes_in,bytes_out,$")
_PROCESS_RE = re.compile(r"^(?P<name>.*)\.(?P<pid>\d+),(?P<rx>\d*),(?P<tx>\d*),$")
_CONN_RE = re.compile(r"^(?P<proto>tcp4|tcp6|udp4|udp6) (?P<local>\S+)<->(?P<remote>\S+),(?P<rx>\d*),(?P<tx>\d*),$")


def _split_endpoint(proto, endpoint):
    """nettop 的端点写法：IPv4 是 `1.2.3.4:443`，IPv6 是 `2001:db8::1.443`（用点分端口，
    因为冒号已经被地址占了）；`*` 表示未指定（监听 socket / 未连接的 UDP），跳过。"""
    if endpoint.startswith("*") or endpoint.endswith("*"):
        return None, None
    sep = "." if proto.endswith("6") else ":"
    if sep not in endpoint:
        return None, None
    ip, _, port = endpoint.rpartition(sep)
    if not ip or not port.isdigit():
        return None, None
    return ip, int(port)


def _is_claude_argv(args):
    """老名字，留给还在 import 它的代码；现在按 Agent 注册表认所有 agent。"""
    return _agent_of(args.split(None, 1)[0].rsplit("/", 1)[-1] if args and args.strip() else "", args) is not None


def _agent_of(comm, args):
    return registry.classify_process(comm, args, None)


def claude_process_tree():
    """返回 {pid: (uid, comm, root_pid, agent_id)}，包含所有 AI agent 根进程（Claude Code / Codex /
    Gemini CLI / ……，按注册表认）及其全部子进程。每次采样都重新算一遍——子进程（bash/curl...）
    随时在生灭，新起的 agent 会话也要能自动跟上。"""
    try:
        out = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,uid=,comm=,args="],
            capture_output=True, text=True, timeout=5, check=False,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return {}
    procs = {}
    children = {}
    roots = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 4:
            continue
        pid, ppid, uid, comm = int(parts[0]), int(parts[1]), int(parts[2]), parts[3]
        args = parts[4] if len(parts) > 4 else ""
        procs[pid] = (uid, comm.rsplit("/", 1)[-1])
        children.setdefault(ppid, []).append(pid)
        agent = _agent_of(comm.rsplit("/", 1)[-1], args)
        if agent:
            roots.append((pid, agent))
    tree = {}
    for root, agent in roots:
        stack = [root]
        while stack:
            pid = stack.pop()
            if pid in tree:
                continue  # 嵌套的 agent（在 Claude Code 里跑 codex）归外层根，跟 Linux 探针口径一致
            uid, comm = procs.get(pid, (0, "?"))
            tree[pid] = (uid, comm, root, agent)
            stack.extend(children.get(pid, []))
    return tree


class NettopProbe:
    def __init__(self):
        self.seen_conns = set()  # (pid, proto, local, remote)：见过的连接，用来判断"新连接"
        self.first_sample = True  # 第一份采样是累计值不是增量，只记连接、不记字节
        self.tree = {}
        self.current_pid = None

    def handle_line(self, line):
        line = line.rstrip("\n")
        if _HEADER_RE.match(line):
            # 新一份采样开始：重新拿一次进程树（顺序不能反，连接行紧跟在进程行后面，
            # 树得在处理这份采样的进程行之前就是新的）
            self.tree = claude_process_tree()
            self.current_pid = None
            return
        m = _PROCESS_RE.match(line)
        if m:
            pid = int(m.group("pid"))
            self.current_pid = pid if pid in self.tree else None
            return
        if self.current_pid is None:
            return
        m = _CONN_RE.match(line)
        if not m:
            return
        proto = m.group("proto")
        ip, port = _split_endpoint(proto, m.group("remote"))
        if ip is None:
            return
        rx = int(m.group("rx") or 0)
        tx = int(m.group("tx") or 0)
        key = (self.current_pid, proto, m.group("local"), m.group("remote"))
        if key not in self.seen_conns:
            self.seen_conns.add(key)
            self._on_connect(self.current_pid, ip, port)
        if not self.first_sample and (rx or tx):
            storage.record_network_bytes(ip, port, tx_bytes=tx, rx_bytes=rx)

    def end_of_sample(self):
        self.first_sample = False
        # seen_conns 只增不减会随时间慢慢涨；连接早就关了的 key 留着没意义。
        # 简单粗暴：超过一万条就清空，代价只是接下来一轮把当前还开着的连接再记一次 CONNECT。
        if len(self.seen_conns) > 10000:
            self.seen_conns.clear()

    def _on_connect(self, pid, ip, port):
        uid, comm, root, agent = self.tree.get(pid, (0, "?", pid, None))
        host = _reverse_dns(ip)
        target = "{} ({})".format(ip, host) if host else ip
        storage.log_event(
            session_id="",
            source="os_net",
            tool_name=comm,
            detail={"pid": str(pid), "uid": str(uid), "root_pid": str(root), "agent": agent,
                    "ip": ip, "port": str(port), "host": host},
            cwd="",
            risk="info",
            matched_rule=None,
            decision="observed",
            agent=agent or storage.DEFAULT_AGENT,
        )
        storage.record_network_connect(ip, port, host)
        print("[CC-Monitor][probe] 网络连接: agent={} pid={} comm={} -> {}:{}".format(
            agent or "?", pid, col.c(comm, color="cyan"), col.c(target, color="blue"), port
        ), flush=True)


def run():
    if not shutil.which("nettop"):
        print("错误: 找不到 nettop（macOS 自带在 /usr/bin/nettop）", file=sys.stderr)
        sys.exit(1)
    print(col.c(
        "[CC-Monitor][probe] 启动系统层探针 (macOS nettop)，每 {}s 采样 AI agent 进程树的网络连接/字节数...".format(SAMPLE_INTERVAL_SEC),
        color="cyan",
    ))
    # -n 不做反向解析（我们自己做、自己缓存）；-x 纯数字；-d 增量模式（第一份是累计，
    # 之后每份是相对上一份的增量）；-L 0 无限采样、CSV 输出；不带 -p：进程集合会变
    # （新会话/子进程），nettop 的 -p 是启动时定死的，所以全量输出、按 pid 自己过滤。
    cmd = ["nettop", "-n", "-x", "-d", "-L", "0", "-s", str(SAMPLE_INTERVAL_SEC), "-J", "bytes_in,bytes_out"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    probe = NettopProbe()
    # 被 kill/系统关机（SIGTERM）时也要走到下面的 finally 把 nettop 子进程收掉，不然它会
    # 变成孤儿一直采样。默认的 SIGTERM 处理是直接结束进程，finally 根本不会执行。
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print(col.c("[CC-Monitor][probe] 就绪（不需要 root；Ctrl+C 停止）", color="green"), flush=True)
    try:
        pending_header = False
        for line in proc.stdout:
            if _HEADER_RE.match(line.rstrip("\n")):
                # 上一份采样到此结束
                if pending_header:
                    probe.end_of_sample()
                pending_header = True
            probe.handle_line(line)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
    if proc.returncode not in (None, 0, -15):
        err = (proc.stderr.read() or "").strip()
        print(col.c("[CC-Monitor][probe] nettop 退出，返回码 {}: {}".format(proc.returncode, err), color="yellow"), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    run()
