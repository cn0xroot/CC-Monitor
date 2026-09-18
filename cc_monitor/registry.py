"""Agent 注册表：CC-Monitor 认识哪些 AI agent、每家长什么样。

每个 agent 一份 JSON（cc_monitor/agents/<id>.json），描述四件事：
  - process：系统层探针怎么认出它的进程（comm / 可执行文件名 / argv 特征 / 它自己的基础设施噪音）
  - hooks：应用层怎么接（协议名、配置文件在哪、它的事件名对应我们的哪个 hook 模式）
  - tools / field_aliases：它的工具名和入参字段名怎么映射成 Claude Code 词汇（规则表、越界检测
    和 Web UI 统计全部按 Claude Code 的工具名写，其它 agent 的名字进引擎之前先翻译）
  - 各种路径：会话文件在哪、家目录下哪些是它自己的状态目录（越界检测要忽略）、项目根标记、
    配置文件（篡改检测规则要看）

代码里不写死任何一家 agent 的名字；要接一个新 agent，原则上只加一份 JSON（有特殊 hook 协议
的再加一个 adapters/<protocol>.py）。

用户可以在 $CC_MONITOR_HOME/agents/<id>.json 放同名文件覆盖或新增（比如某台机器上 codex 装成
了别的名字），字段级合并：用户文件里有的键覆盖默认值，没有的沿用默认。
"""
import json
import os
import re
from pathlib import Path

AGENTS_DIR = Path(__file__).parent / "agents"
CONFIG_DIR = Path(os.environ.get("CC_MONITOR_HOME", str(Path.home() / ".cc-monitor")))
USER_AGENTS_DIR = CONFIG_DIR / "agents"

DEFAULT_AGENT = "claude-code"

_cache = None


def _read(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("id") else None


def _merge(base, override):
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load_all(refresh=False):
    """返回 {agent_id: spec}。第一次调用读盘，之后用缓存（hook 进程一次只活几百毫秒，
    探针/Web UI 这种常驻进程要拿新配置就传 refresh=True）。"""
    global _cache
    if _cache is not None and not refresh:
        return _cache
    agents = {}
    for path in sorted(AGENTS_DIR.glob("*.json")):
        spec = _read(path)
        if spec:
            agents[spec["id"]] = spec
    if USER_AGENTS_DIR.is_dir():
        for path in sorted(USER_AGENTS_DIR.glob("*.json")):
            spec = _read(path)
            if not spec:
                continue
            agents[spec["id"]] = _merge(agents.get(spec["id"], {}), spec)
    _cache = agents
    return agents


def get(agent_id):
    """按 id 取一份 spec；不认识的 id 返回 None（调用方决定是报错还是退回默认）。"""
    return load_all().get(agent_id or DEFAULT_AGENT)


def ids():
    return list(load_all().keys())


def hook_capable_ids():
    """有应用层 hook 协议的 agent（install.py 只对这些有事可做）。"""
    return [aid for aid, spec in load_all().items() if spec.get("hooks")]


def status(agent_id):
    """"verified"（真机验证过）或 "experimental"（按文档/源码实现、未验证）。缺省按实验性算。"""
    spec = get(agent_id)
    return (spec or {}).get("status") or "experimental"


def display_name(agent_id):
    spec = get(agent_id)
    return spec["display"] if spec else (agent_id or DEFAULT_AGENT)


# ---- 系统层探针用 ----

def root_comms():
    """所有 agent 的 comm 精确名 → [(comm, agent_id)]。渲染进 bpftrace 脚本的 execve 探点。"""
    out = []
    for aid, spec in load_all().items():
        for comm in (spec.get("process") or {}).get("comm") or []:
            out.append((comm, aid))
    return out


def root_comm_prefixes():
    """comm 前缀匹配（内核把 comm 截到 15 字节，codex 的原生二进制名太长只能按前缀认）。"""
    out = []
    for aid, spec in load_all().items():
        for prefix in (spec.get("process") or {}).get("comm_prefix") or []:
            out.append((prefix[:15], aid))
    return out


def classify_process(comm, argv, exe=None):
    """给一个 (comm, argv, exe) 判断是哪家 agent 的根进程；都不是返回 None。
    先比 comm 精确/前缀（编译型 agent），再比可执行文件名，最后比 argv 正则（node/python
    托管的 agent 只能靠这个——shebang 脚本经 env 再 exec 之后 comm 是解释器名）。"""
    comm = (comm or "").strip()
    argv = argv or ""
    exe_base = os.path.basename(exe) if exe else ""
    argv0 = argv.split(None, 1)[0] if argv else ""
    argv0_base = os.path.basename(argv0)
    for aid, spec in load_all().items():
        proc = spec.get("process") or {}
        if comm and comm in (proc.get("comm") or []):
            return aid
        if comm and any(comm.startswith(p[:15]) for p in proc.get("comm_prefix") or []):
            return aid
        bases = proc.get("exe_basename") or []
        if (exe_base and exe_base in bases) or (argv0_base and argv0_base in bases):
            return aid
    for aid, spec in load_all().items():
        proc = spec.get("process") or {}
        for pat in proc.get("argv_patterns") or []:
            try:
                if re.search(pat, argv):
                    return aid
            except re.error:
                continue
    return None


def infra_noise_patterns(agent_id=None):
    """agent 自己的基础设施命令（hook 执行本身、状态栏刷新之类），探针的绕过判定要排除。
    不传 agent_id 就合并所有家的（探针刚起来、还没把进程归到某家时用）。"""
    pats = []
    specs = [get(agent_id)] if agent_id else load_all().values()
    for spec in specs:
        if not spec:
            continue
        for p in (spec.get("process") or {}).get("infra_noise") or []:
            try:
                pats.append(re.compile(p))
            except re.error:
                continue
    return pats


def shell_comms(agent_id=None):
    out = set()
    specs = [get(agent_id)] if agent_id else load_all().values()
    for spec in specs:
        if spec:
            out.update((spec.get("process") or {}).get("shell_comms") or [])
    return out or {"sh", "bash", "zsh", "dash", "ksh"}


# ---- 越界检测 / 规则用 ----

def file_ignore_globs():
    """探针文件级观测要忽略的路径 glob（各 agent 自己的自更新探测文件之类），fnmatch 语法。"""
    out = []
    for spec in load_all().values():
        for g in (spec.get("process") or {}).get("file_ignore_globs") or []:
            if g not in out:
                out.append(g)
    return tuple(out)


def home_ignore():
    out = []
    for spec in load_all().values():
        for rel in spec.get("home_ignore") or []:
            if rel not in out:
                out.append(rel)
    return tuple(out)


def state_dirs(agent_id=None):
    """agent 自己的状态目录（家目录下的相对路径：.claude、.codex、.gemini……）。探针的文件级观测
    用它判断"agent 进程自己写这些路径是正常维护自身状态，不是绕过 hook 写文件"。"""
    out = []
    specs = [get(agent_id)] if agent_id else load_all().values()
    for spec in specs:
        if not spec:
            continue
        for rel in spec.get("state_dirs") or []:
            if rel not in out:
                out.append(rel)
    return tuple(out)


def project_markers():
    out = [".git", ".hg", ".svn"]
    for spec in load_all().values():
        for m in spec.get("project_markers") or []:
            if m not in out:
                out.append(m)
    return tuple(out)


def config_tamper_pattern():
    """所有 agent 的配置/hook 文件路径正则用 | 拼成一个——篡改任何一家的 hook 配置都等于
    关掉那一家的应用层监测，这条规则在多 agent 之后比以前更重要。"""
    parts = []
    for spec in load_all().values():
        parts.extend(spec.get("config_tamper_paths") or [])
    return "|".join(parts)


def history_pattern():
    parts = []
    for spec in load_all().values():
        parts.extend(spec.get("history_paths") or [])
    return "|".join(parts)


# ---- 应用层适配器用 ----

def map_tool(agent_id, native_tool):
    """把 agent 自己的工具名翻译成 Claude Code 词汇；映射表里没有的原样返回（只会命中
    tools:["*"] 和 field=="tool_name" 的规则，同时被统计成"未知工具"，不会静默丢掉）。"""
    spec = get(agent_id)
    if not spec:
        return native_tool
    return (spec.get("tools") or {}).get(native_tool, native_tool)


def map_fields(agent_id, tool_input):
    """入参字段名翻译（比如 OpenCode 的 filePath → file_path）。原对象不动，返回新 dict。"""
    spec = get(agent_id)
    if not isinstance(tool_input, dict):
        return {}
    aliases = (spec.get("field_aliases") or {}) if spec else {}
    out = {}
    for k, v in tool_input.items():
        out[aliases.get(k, k)] = v
    return out
