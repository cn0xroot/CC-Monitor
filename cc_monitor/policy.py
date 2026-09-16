import copy
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

from . import workdir

CONFIG_DIR = Path(os.environ.get("CC_MONITOR_HOME", str(Path.home() / ".cc-monitor")))
RULES_PATH = CONFIG_DIR / "rules.json"
SNAPSHOT_PATH = CONFIG_DIR / "rules.defaults_snapshot.json"
DEFAULT_RULES_PATH = Path(__file__).parent / "default_rules.json"

FIELD_CANDIDATES = {
    "command": ["command"],
    "file_path": ["file_path", "path", "notebook_path"],
    "url": ["url"],
    # Write 用 "content"，Edit 用 "new_string"，NotebookEdit 用 "new_source"——
    # 三个工具语义上都是"即将写进文件的内容"，一条按内容扫描密钥格式的规则要
    # 同时认这三个字段名，跟上面 file_path 的多候选写法是同一个道理。
    "content": ["content", "new_string", "new_source"],
}


def _atomic_write(path, text):
    # hook 是每次工具调用都各起一个进程，两个进程同时想改 rules.json 的话，
    # 先写临时文件再 rename 能保证读到的永远是一份完整的 JSON，不会读到半截。
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, str(path))
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _sync_new_default_rules(defaults):
    """把 default_rules.json 里新增的规则合并进用户的 ~/.cc-monitor/rules.json。

    rules.json 是首次运行时拷的副本，以前版本升级后新增的规则（比如 history_read）
    根本不会出现在老用户的文件里，导致"新版本明明有这条规则却检测不到"。合并规则：
    - 本地缺失的默认规则按 id 补上，插在它在默认表里前一条规则的后面（规则表是
      有序的、首个命中即返回，位置不能乱放）。
    - rules.defaults_snapshot.json 存着上一次同步时的默认规则表。本地某条规则跟
      快照里的一模一样，说明用户没改过，默认表里这条规则变了（比如修正正则）就
      直接换成新的；跟快照不一样（用户改过 action/pattern）一律不动。
    - 本地缺失、但快照里有的 id，说明是用户自己删掉的，不再补回来。
    - 没有快照（老版本升上来的第一次）时分不清"用户改过"和"老版本默认值"，只补
      缺失的、不碰已有的，最保守。"""
    local = _read_json(RULES_PATH)
    if not isinstance(local, list):
        return None
    snapshot = _read_json(SNAPSHOT_PATH)
    snapshot = {r.get("id"): r for r in snapshot if isinstance(r, dict)} if isinstance(snapshot, list) else {}

    local_ids = {r.get("id") for r in local if isinstance(r, dict)}
    changed = False
    insert_at = 0
    for rule in defaults:
        rid = rule.get("id")
        if rid in local_ids:
            idx = next(i for i, r in enumerate(local) if isinstance(r, dict) and r.get("id") == rid)
            insert_at = idx + 1
            if rid in snapshot and local[idx] == snapshot[rid] and rule != snapshot[rid]:
                local[idx] = copy.deepcopy(rule)
                changed = True
            continue
        if rid in snapshot:
            continue
        local.insert(insert_at, copy.deepcopy(rule))
        local_ids.add(rid)
        insert_at += 1
        changed = True

    try:
        if changed:
            _atomic_write(RULES_PATH, json.dumps(local, ensure_ascii=False, indent=2) + "\n")
        if list(snapshot.values()) != defaults:
            _atomic_write(SNAPSHOT_PATH, json.dumps(defaults, ensure_ascii=False, indent=2) + "\n")
    except OSError:
        # 配置目录只读之类的情况：这次就用内存里已合并的结果，不影响 hook 本身继续跑。
        pass
    return local if changed else None


def ensure_config():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    defaults = _read_json(DEFAULT_RULES_PATH) or []
    if not RULES_PATH.exists():
        _atomic_write(RULES_PATH, DEFAULT_RULES_PATH.read_text(encoding="utf-8"))
        _atomic_write(SNAPSHOT_PATH, DEFAULT_RULES_PATH.read_text(encoding="utf-8"))
        return None
    return _sync_new_default_rules(defaults)


def _fill_display_text(rules):
    """给缺 title/desc 的规则按 id 补上内置默认表里的文案（只在内存里补，不写回
    用户的 rules.json）。用户改过的规则不会被 _sync_new_default_rules 覆盖，于是拿不到
    新版加的说明文字——但审批提示总得有句人话，所以展示层回退到默认文案。"""
    defaults = _read_json(DEFAULT_RULES_PATH) or []
    by_id = {r.get("id"): r for r in defaults if isinstance(r, dict)}
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        src = by_id.get(rule.get("id"))
        if not src:
            continue
        for key in ("title", "desc", "title_en", "desc_en"):
            if not rule.get(key) and src.get(key):
                rule[key] = src[key]
    return rules


def load_rules():
    try:
        merged = ensure_config()
    except OSError:
        merged = None
    if merged is not None:
        return _fill_display_text(merged)
    local = _read_json(RULES_PATH)
    if isinstance(local, list):
        return _fill_display_text(local)
    return json.loads(DEFAULT_RULES_PATH.read_text(encoding="utf-8"))


def _extract(tool_input, field):
    for key in FIELD_CANDIDATES.get(field, [field]):
        value = tool_input.get(key)
        if value is not None:
            if isinstance(value, str):
                return value
            # 不是字符串的字段（比如 AskUserQuestion 的 questions 是个列表）——用
            # json.dumps 而不是 str()，后者是 Python repr（单引号、True/False 大写
            # 那一套），前端拿到手没法当 JSON 解析；已有规则的 field 全是字符串
            # （command/file_path/url），这个分支不会改变它们的行为。
            return json.dumps(value, ensure_ascii=False)
    return None


# ---- "segment" 匹配模式：只看每个子命令的开头 ----
#
# 默认的 match="search" 是对整条命令文本做 re.search，引号里的字符串、heredoc 正文、
# grep 的搜索词都会被扫到——实测审计库里 "系统包管理器安装" 命中的 10 条事件全是
# `grep "port install"`、python heredoc 里写着 "apt install" 字样的命令，没有一条是
# 真的在装软件。match="segment" 把命令按顶层的 ; & | 换行 切成子命令（引号/heredoc
# 内部的分隔符不算），每段剥掉 sudo/env/xargs/time 这类包装前缀和可执行文件的路径
# 前缀之后，用 re.match 从开头匹配。`bash -c "..."`/`osascript ... do shell script "..."`
# 这两种"字符串就是要执行的命令"的写法会递归进字符串里再切一遍，不会因为多了一层
# 引号就漏掉真正的安装。跟 webui/lib/audit.js 的 splitShellSegments 是同一个思路。

_WRAPPER_RE = re.compile(
    r"^(?:"
    r"sudo(?:\s+(?:-[ugCDhprtUT]\s+\S+|--\S+|-[A-Za-z]+))*"
    r"|doas(?:\s+-u\s+\S+)?"
    r"|env(?:\s+(?:-\S+|\w+=\S*))*"
    r"|xargs(?:\s+(?:-[InLPdsE]\s*\S+|-\S+))*"
    r"|nice(?:\s+-n\s*\S+)?"
    r"|command|exec|time|nohup|builtin|caffeinate"
    r")\s+"
    # 不加 IGNORECASE：sudo 的 -H/-E/-i 是不带参数的，-h/-u/-t 才带参数，大小写敏感才分得开。
)
_ENV_ASSIGN_RE = re.compile(r"^(?:[A-Za-z_]\w*=(?:'[^']*'|\"[^\"]*\"|\S*)\s+)+")
_SHELL_C_RE = re.compile(
    r"^(?:sh|bash|zsh|dash|ksh|fish)\s+(?:-\S+\s+)*-c\s+(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\")",
    re.IGNORECASE | re.DOTALL,
)
_OSASCRIPT_RE = re.compile(r"do shell script\s+\"((?:[^\"\\]|\\.)*)\"", re.IGNORECASE | re.DOTALL)
_HEREDOC_RE = re.compile(r"^<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def split_shell_segments(cmd):
    """按顶层的 ; & | 换行 切子命令；单/双引号内、heredoc 正文内的分隔符不算数。"""
    cmd = cmd.replace("\\\n", " ")
    segments = []
    cur = []
    i = 0
    n = len(cmd)
    quote = None
    heredoc_end = None
    while i < n:
        if heredoc_end is not None:
            line_end = cmd.find("\n", i)
            line = cmd[i:] if line_end == -1 else cmd[i:line_end]
            cur.append(line)
            if line.strip() == heredoc_end:
                heredoc_end = None
            if line_end == -1:
                i = n
            else:
                cur.append("\n")
                i = line_end + 1
            continue
        ch = cmd[i]
        if quote:
            cur.append(ch)
            if ch == "\\" and quote == '"' and i + 1 < n:
                cur.append(cmd[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            cur.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            cur.append(cmd[i:i + 2])
            i += 2
            continue
        if ch == "<" and cmd[i + 1:i + 2] == "<":
            m = _HEREDOC_RE.match(cmd[i:])
            if m:
                cur.append(m.group(0))
                i += len(m.group(0))
                nl = cmd.find("\n", i)
                if nl == -1:
                    cur.append(cmd[i:])
                    i = n
                else:
                    cur.append(cmd[i:nl + 1])
                    i = nl + 1
                    heredoc_end = m.group(2)
                continue
        if ch in ";&|\n":
            segments.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(ch)
        i += 1
    if cur:
        segments.append("".join(cur))
    return segments


def _normalize_head(seg):
    """剥掉子命令开头的括号、环境变量赋值、sudo/env/xargs 之类的包装，再把可执行文件的
    路径前缀去掉（/opt/local/bin/port -> port）。"""
    seg = seg.strip().lstrip("({").strip()
    while True:
        before = seg
        seg = _ENV_ASSIGN_RE.sub("", seg)
        seg = _WRAPPER_RE.sub("", seg)
        if seg == before:
            break
    m = re.match(r"^(\S*/)(\S+)", seg)
    if m:
        seg = seg[len(m.group(1)):]
    return seg


def _unescape(text):
    return re.sub(r"\\(.)", r"\1", text)


def segment_heads(cmd, depth=0):
    """把一条 Bash 命令展开成一组子命令，供 match="segment" 规则逐个从开头匹配。

    每个子命令给出两个版本：只去掉括号/环境变量赋值的"原样"版本（sudo_usage 这种
    规则要看到 sudo 本身），和进一步剥掉 sudo/env/xargs 等包装、可执行文件路径前缀的
    "净头"版本（apt/brew/port 这些规则要看到真正的命令名）。两个版本相同就只给一个。"""
    heads = []
    for raw in split_shell_segments(cmd):
        plain = _ENV_ASSIGN_RE.sub("", raw.strip().lstrip("({").strip())
        head = _normalize_head(raw)
        if not head:
            continue
        if plain and plain != head:
            heads.append(plain)
        heads.append(head)
        if depth >= 3:
            continue
        m = _SHELL_C_RE.match(head)
        if m:
            inner = m.group(1) if m.group(1) is not None else _unescape(m.group(2))
            heads.extend(segment_heads(inner, depth + 1))
            continue
        for om in _OSASCRIPT_RE.finditer(head):
            heads.extend(segment_heads(_unescape(om.group(1)), depth + 1))
    return heads


def rules_fingerprint(rules):
    """规则表的指纹：规则内容（含顺序）一变就变。rematch 用它判断"上次重判之后规则
    有没有改过"，不用比对文件 mtime（rules.json 被自动合并重写、手动 touch 都会改
    mtime，但内容没变就不必重判）。"""
    payload = json.dumps(rules, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def evaluate(tool_name, tool_input, rules=None, cwd=None):
    """Return (rule, matched_value) for the first matching rule, or (None, None).

    matched_value：search 模式下是被匹配的整个字段值；segment 模式下是命中的那个子命令
    （已剥掉 sudo/env 等包装），审批台/拦截原因里展示这个比整条命令更直观；workdir
    模式下是落在工作目录之外的那些路径（家目录折叠成 ~）。
    rules 不传就每次现读 rules.json（hook 一次只判一条，读一次没关系）；rematch 要
    对几千条历史事件逐条判，传进来一份预加载的表避免反复读文件。
    cwd 是 hook 输入里 Claude Code 的当前工作目录，只有 match="workdir" 的规则用得到
    ——不传（老的调用方/单测）这类规则一律不命中。"""
    if rules is None:
        rules = load_rules()
    workdir_hits = None  # 一次 evaluate 里最多扫一遍路径，几条 workdir 规则共用
    for rule in rules:
        tools = rule.get("tools", ["*"])
        if "*" not in tools and tool_name not in tools:
            continue
        if rule.get("match") == "workdir":
            # 跨工作目录检测不是正则：看的是路径相对 cwd 的位置（见 workdir.py）。
            # 规则用 scopes（homeDotfile/otherUserHome/system/otherProject）和
            # access（read/write/any）挑自己关心的那一类，ignore_paths 额外加白名单。
            if not cwd:
                continue
            if workdir_hits is None:
                try:
                    workdir_hits = workdir.scan(tool_name, tool_input, cwd)
                except Exception:
                    workdir_hits = []
            selected = workdir.select(workdir_hits, rule.get("scopes"), rule.get("access"), rule.get("ignore_paths"))
            if selected:
                return rule, workdir.describe(selected)
            continue
        # field="tool_name" 是个特例：匹配的是 evaluate() 的 tool_name 参数本身，不是
        # tool_input 里的字段——MCP 工具调用的 tool_name 是运行时才知道的动态字符串
        # （形如 "mcp__<server>__<tool>"），没法像 Bash/Write 那样枚举进 "tools" 列表，
        # 只能靠这条规则的 pattern 去认里面的 server/tool 名字。
        value = tool_name if rule["field"] == "tool_name" else _extract(tool_input, rule["field"])
        if value is None:
            continue
        try:
            if rule.get("match") == "segment":
                for head in segment_heads(value):
                    if re.match(rule["pattern"], head, re.IGNORECASE):
                        return rule, head
            elif re.search(rule["pattern"], value, re.IGNORECASE):
                return rule, value
        except re.error:
            continue
    return None, None
