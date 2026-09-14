"""系统层探针（Linux / eBPF）。

独立于 Claude Code 的 hooks，用 bpftrace 直接在内核层跟踪从 `claude` 进程派生出来的
子进程树的 execve/connect。目的：交叉验证应用层 hooks 是否被绕过或篡改——
hooks 是"自证清白"，这里是不依赖 Claude Code 配合的独立观察，因此必须以 root 运行。

用法: sudo python3 -m cc_monitor.probe   (或 sudo bin/CC-Monitor-probe)
"""
import json
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

from . import colors as col
from . import policy, storage

BT_SCRIPT = Path(__file__).parent / "probe_linux.bt"

# 顶层 shell 的 comm，用来判断一条 EXEC 是不是"入口命令"（可以跟 hook_pre 的
# command 字段直接比对），而不是入口命令派生出的孙子进程（比如 bash -c 里
# 又跑了 python/awk，这些天然是被批准的顶层命令的一部分，不需要单独告警）。
SHELL_COMMS = {"sh", "bash", "zsh", "dash", "ksh"}

# Claude Code CLI 自身的基础设施调用（hook 执行本身、状态栏刷新、终端尺寸探测等）。
# 这些是 CLI 内部实现细节，不是模型发起的工具操作，天然不会出现在 hook_pre 记录里，
# 需要排除，否则每次工具调用都会产生几条误报。按需扩充这个列表。
INFRA_NOISE_PATTERNS = [
    re.compile(r"CC-Monitor-hook"),
    re.compile(r"ccmon-hook"),  # 老版本改名前装过的 hook 路径，兼容一下
    re.compile(r"aimon-hook"),  # 更早的项目名（AI-Monitor）留下的 hook 路径
    re.compile(r"open-island-hook\.js"),
    re.compile(r"ccstatusline"),
    re.compile(r"herdr-agent-state\.sh"),
    re.compile(r"^ps -o (ppid|tty)="),
    re.compile(r"^stty -F \S+ size"),
]

# 同一条命令在 hook 层和探针层出现的时间差在这个窗口内都算"对得上"。
CORRELATION_WINDOW_SEC = 15
DNS_CACHE_TTL_SEC = 3600


def _is_infra_noise(command_text):
    return any(p.search(command_text) for p in INFRA_NOISE_PATTERNS)


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


def _extract_shell_command(argv_line):
    """从 `bash -c '<command>'` 这样的 argv 中把 <command> 抠出来，用于跟 hook 层比对。"""
    parts = argv_line.split(None, 1)
    if not parts:
        return None
    prog = parts[0].rsplit("/", 1)[-1]
    if prog not in SHELL_COMMS:
        return None
    rest = parts[1] if len(parts) > 1 else ""
    if rest.startswith("-c "):
        cmd = rest[3:]
        return None if _is_infra_noise(cmd) else cmd
    return None


_QUOTE_CHARS = str.maketrans("", "", "'\"")


def _normalize(text):
    """去掉所有引号字符。

    shell 在把原始命令套进 `eval '<command>'` 包装脚本时，如果命令本身含单引号，
    会转义成 `'"'"'` 这种序列（结束引号、转义一个引号、重新开引号）——纯粹是引号
    记法上的变化，不影响命令的实际内容。比对前把两边的引号都剥掉，就不会被这种
    转义差异搞出假阳性。
    """
    return text.translate(_QUOTE_CHARS)


def _find_matching_hook_command(haystack_text, around_ts_epoch):
    """检查最近的 hook_pre Bash 记录里，有没有哪一条的原始命令整段被包含在这次观测到
    的 shell 调用文本里。

    之所以反过来找"hook 记录是不是这段观测文本的子串"，是因为 Claude Code 的 Bash
    工具经常会把用户命令包一层 shell 快照/eval 脚本再执行（比如
    `zsh -c "source snapshot.sh && eval '<原始命令>' < /dev/null && ..."`），
    所以探针看到的 argv 文本通常比 hook 记录的 command 字段更长、包着它。
    """
    if not haystack_text:
        return True  # 不是可比对的 shell -c 命令（比如 ps/awk 这类子进程），不参与比对
    haystack_norm = _normalize(haystack_text)
    rows = storage.fetch_last(limit=300)
    for row in rows:
        (_id, ts, source, tool_name, _risk, _rule, _decision, detail_raw, _cwd) = row
        if source != "hook_pre" or tool_name != "Bash":
            continue
        try:
            ts_epoch = time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            continue
        if abs(ts_epoch - around_ts_epoch) > CORRELATION_WINDOW_SEC:
            continue
        try:
            hook_cmd = (json.loads(detail_raw).get("command") or "").strip()
        except json.JSONDecodeError:
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


def _handle_exec_line(fields):
    # EXEC \t pid \t uid \t comm \t argv...
    _tag, pid, uid, comm, argv_line = fields[0], fields[1], fields[2], fields[3], fields[4] if len(fields) > 4 else ""
    now = time.time()

    if _already_seen(pid, argv_line, now):
        return

    shell_cmd = _extract_shell_command(argv_line)
    matched = _find_matching_hook_command(shell_cmd, now)

    rule, matched_value = (None, None)
    if shell_cmd:
        rule, matched_value = policy.evaluate("Bash", {"command": shell_cmd})

    risk = rule["risk"] if rule else ("high" if not matched else "info")
    note = "命令与 hook 记录对不上，可能绕过了监测" if not matched else None

    storage.log_event(
        session_id="",
        source="os_exec",
        tool_name=comm,
        detail={
            "pid": pid,
            "uid": uid,
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
    )
    if not matched:
        msg = "[CC-Monitor][probe] ⚠ 可能绕过监测: pid={} comm={} 命令未见于 hook 记录: {}".format(
            pid, comm, (shell_cmd or argv_line)[:200]
        )
        print(col.c(msg, color="bright_red", bold=True), file=sys.stderr)
    elif rule:
        msg = "[CC-Monitor][probe] [{}] pid={} comm={} 命中规则 {}: {}".format(
            risk, pid, comm, rule["id"], shell_cmd[:200]
        )
        print(col.c(msg, color=col.RISK_COLOR.get(risk, "gray"), bold=(risk == "high")))


def _handle_connect_line(fields):
    # CONNECT \t pid \t uid \t comm \t ip \t port \t dns_query_host
    # dns_query_host 来自 uprobe:libc:getaddrinfo 抓到的、这个进程连接前实际问过的
    # 域名（比如 "api.anthropic.com"）——比事后对 IP 做反向 DNS 靠谱得多：很多云厂商/
    # CDN 出口 IP 根本没配 PTR 记录，反向解析永远拿不到域名，但这里在连接发生之前
    # 就已经知道域名是什么了。反向 DNS 留着当兜底（万一没经过 getaddrinfo，比如
    # 直接连 IP 字面量的场景）。
    _tag, pid, uid, comm, ip, port, dns_query_host = fields
    host = dns_query_host or _reverse_dns(ip)
    target = "{} ({})".format(ip, host) if host else ip
    storage.log_event(
        session_id="",
        source="os_net",
        tool_name=comm,
        detail={"pid": pid, "uid": uid, "ip": ip, "port": port, "host": host},
        cwd="",
        risk="info",
        matched_rule=None,
        decision="observed",
    )
    storage.record_network_connect(ip, int(port), host)
    msg = "[CC-Monitor][probe] 网络连接: pid={} comm={} -> {}:{}".format(
        pid, col.c(comm, color="cyan"), col.c(target, color="blue"), port
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


def run():
    if shutil.which("bpftrace") is None:
        print(
            "错误: 未找到 bpftrace，请先安装（如 Debian/Ubuntu: apt install bpftrace）。"
            "这个探针依赖 Linux 内核的 eBPF 子系统，macOS 上没有等价物，装不了也跑不起来。",
            file=sys.stderr,
        )
        sys.exit(1)
    if not BT_SCRIPT.exists():
        print("错误: 找不到探针脚本 {}".format(BT_SCRIPT), file=sys.stderr)
        sys.exit(1)

    print(col.c("[CC-Monitor][probe] 启动系统层探针 (bpftrace)，跟踪 claude 进程树的 exec/connect...", color="cyan"))
    proc = subprocess.Popen(
        ["bpftrace", str(BT_SCRIPT)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    known_tags = {"READY", "EXEC", "CONNECT"}
    pending = None  # 正在组装的一条记录（字段列表），最后一个字段可能横跨多行

    def flush(rec):
        if not rec:
            return
        try:
            if rec[0] == "READY":
                print(col.c("[CC-Monitor][probe] 就绪", color="green"))
            elif rec[0] == "EXEC":
                _handle_exec_line(rec)
            elif rec[0] == "CONNECT":
                _handle_connect_line(rec)
        except Exception as exc:  # 探针本身绝不能因为单条解析失败而退出
            msg = "[CC-Monitor][probe] 解析事件出错: {} (记录: {})".format(exc, rec)
            print(col.c(msg, color="yellow"), file=sys.stderr)

    try:
        for raw_line in proc.stdout:
            line = raw_line.rstrip("\n")
            if not line or line.startswith("Attaching"):
                continue
            # @tx_bytes[...]/@rx_bytes[...] 是 bpftrace 自己 print() 一个 map 时的
            # 默认格式，没有 \t，跟 EXEC/CONNECT 那套 tag\t字段 的格式完全不是一回事——
            # 必须在按 \t 切分、判断多行续接之前先认出来单独处理，不然会被误当成
            # 正在组装的上一条 EXEC 记录的续行，把命令内容污染掉。
            if _handle_bytes_line(line):
                continue
            fields = line.split("\t")
            if fields[0] in known_tags:
                flush(pending)
                pending = fields
            elif pending is not None:
                # 命令本身带换行（比如多行脚本），bpftrace 会原样打印出来，
                # 这里把它接回上一条记录的最后一个字段（argv/command），而不是当成新记录丢掉。
                pending[-1] = pending[-1] + "\n" + line
        flush(pending)
    except KeyboardInterrupt:
        pass
    finally:
        proc.terminate()


if __name__ == "__main__":
    run()
