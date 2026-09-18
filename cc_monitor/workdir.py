"""跨工作目录行为检测：AI 这次工具调用碰的路径，是不是跑到了当前项目目录之外。

default_rules.json 里的规则都是"对某个字段做正则"——正则看不见 hook 输入里的 cwd，
判断不了"这个路径相对于当前项目在哪"。这个模块补的就是这一块：把一次工具调用里
所有会被访问的文件系统路径抠出来（文件类工具直接看 file_path/path，Bash 要按子命令
拆开逐个 token 认路径、跟踪 cd），解析成绝对路径，跟 cwd 比对，落在项目外的按位置
分档：

- homeDotfile   ：家目录下的隐藏文件/目录（~/.ssh、~/.aws、~/.config、~/.claude …），
                  凭据和配置基本都住这里
- otherUserHome ：别的用户的家目录（/home/<别人>、/Users/<别人>、/root）
- system        ：系统目录（/etc、/usr、/var、/opt、/Library …）
- otherProject  ：其它都算这档——家目录下别的项目、/data、/mnt 之类

再区分读/写：Write/Edit 类工具、rm/mv/cp 目标/tee/重定向 这些是写，其余是读。
policy.evaluate() 里 match="workdir" 的规则拿这份结果按 scopes/access 过滤，命中就
跟普通规则一样走 log/confirm/block。

几个刻意不报的地方（报了全是噪音）：
- "工作目录"按项目根算，不按 hook 给的 cwd 算：Claude Code 的 Bash 工具 cd 进子目录之后
  hook 里的 cwd 也会跟着变成子目录（比如 proj/webui），这时候改 proj/README.md 明明还在
  项目里。从 cwd 往上找 .git/.hg/.svn/CLAUDE.md/.claude 这些项目标记，取家目录之下
  最靠上的那一层当项目根；一个标记都没有就还是用 cwd。
- 临时目录（/tmp、/var/tmp、$TMPDIR、macOS 的 /private/var/folders）、/dev
- 只读系统目录里的**读**（/usr、/lib*、/bin、/opt、/Library …）：跑程序、查共享库、看头文件
  都是读这些地方，全报出来一天几百条；往这些地方**写**照样报。~/.cache 同理。
- ~/.claude/projects（Claude Code 自己的会话记录/自动记忆/todo），那是它正常工作的一部分
- 子命令的可执行文件本身在系统目录里（/usr/bin/python3 x.py 是在跑 python，不是在读它）
- Claude Code 自己的 permissions.additionalDirectories（用户明确授权过的额外目录）
- 规则里 ignore_paths 额外列出来的路径

已知局限：
- Claude Code 的 Bash 工具在多次调用之间会记住 shell 的 cwd，但 hook 只拿得到 Claude
  Code 进程自己的 cwd（项目根）。同一条命令里的 `cd ../x && ...` 能跟踪，上一条命令 cd
  出去、这一条再用相对路径的情况认不出来——不过那次 cd 本身已经被记下了。
- 路径字面上在项目里就算项目里，不追符号链接（项目里解包出来的 rootfs 里 service ->
  /etc/sv 这种链接，字面上是在读项目文件，追过去会把整棵树都误报成系统目录）；只有
  字面上在项目外的路径才 realpath 一下再分档。
"""
import json
import os
import re
import shlex
from pathlib import Path

from . import registry

TIER_HOME_DOTFILE = "homeDotfile"
TIER_OTHER_USER = "otherUserHome"
TIER_SYSTEM = "system"
TIER_OTHER = "otherProject"
ALL_TIERS = (TIER_HOME_DOTFILE, TIER_OTHER_USER, TIER_SYSTEM, TIER_OTHER)

ACCESS_READ = "read"
ACCESS_WRITE = "write"

READ_TOOLS = ("Read", "Glob", "Grep", "LS")
WRITE_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")
FILE_TOOL_FIELDS = ("file_path", "path", "notebook_path")

SYSTEM_ROOTS = (
    "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/var", "/opt",
    "/proc", "/sys", "/run", "/srv", "/snap", "/nix", "/cores",
    "/System", "/Library", "/Applications", "/private", "/Network", "/Volumes",
)
USER_HOME_PARENTS = ("/home", "/Users")
# 永远不报的路径前缀：临时目录、设备文件。$TMPDIR 在 _ignored_roots() 里动态加进来。
DEFAULT_IGNORE = ("/tmp", "/var/tmp", "/private/tmp", "/private/var/folders", "/dev")
# 家目录下永远不报的相对路径（对会话涉及的每个家目录都生效）：各家 agent 自己的会话/状态目录
# （~/.claude/projects、~/.codex/sessions、~/.gemini/tmp……），从注册表合并而来。
HOME_IGNORE = registry.home_ignore()
# 只读系统目录：在这些地方"读"不报（跑程序/查库/看头文件），"写"照样按 system 档报
SYSTEM_READ_QUIET = (
    "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/opt", "/snap", "/nix",
    "/System", "/Library", "/Applications",
)
HOME_READ_QUIET = (".cache",)
# 项目根的标记：从 cwd 往上找，家目录之下最靠上的带标记的目录就是项目根。
# .git/.hg/.svn 之外是各家 agent 的项目级配置（CLAUDE.md/.claude、AGENTS.md/.codex、GEMINI.md/.gemini……），
# 从注册表合并而来。
PROJECT_MARKERS = registry.project_markers()

# 这些命令一旦带了路径参数，路径就是被改写的对象。
WRITE_ALL_CMDS = {
    "rm", "rmdir", "touch", "mkdir", "chmod", "chown", "chgrp", "truncate", "shred", "unlink", "tee",
    "dd", "patch", "chattr", "setfacl", "mkfifo", "mknod",
}
# 最后一个路径参数是目标（写），前面的是来源（读）。
WRITE_LAST_CMDS = {"cp", "mv", "ln", "rsync", "install", "scp"}
GIT_WRITE_LAST_SUBCMDS = {"clone", "init"}

_REDIRECT_TOKEN_RE = re.compile(r"^(\d*)(>>|>\||>|&>>|&>)(.*)$")
_HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
_OPT_ASSIGN_RE = re.compile(r"^--?[A-Za-z][\w-]*=(.+)$")
_ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_]\w*=(.*)$")


class Hit(object):
    __slots__ = ("path", "tier", "access")

    def __init__(self, path, tier, access):
        self.path = path
        self.tier = tier
        self.access = access

    @property
    def display(self):
        home = _home()
        if home and (self.path == home or self.path.startswith(home + "/")):
            return "~" + self.path[len(home):]
        return self.path

    def __repr__(self):
        return "Hit({!r}, {}, {})".format(self.path, self.tier, self.access)


def _home():
    return os.path.expanduser("~").rstrip("/") or "/"


def _norm(path):
    return os.path.normpath(path).rstrip("/") or "/"


def _canon(path):
    """比对用的归一化：能 realpath 就 realpath（cwd 是符号链接、目标也是符号链接的话
    两边都解开才比得对），不存在的路径 realpath 也只是 normpath，不会抛。展示给人看
    的仍然是 _norm() 的版本（/etc/os-release 不要变成 /usr/lib/os-release）。"""
    try:
        return os.path.realpath(path).rstrip("/") or "/"
    except (OSError, ValueError):
        return _norm(path)


def _under(path, root):
    return path == root or path.startswith(root + "/")


def _ignored_roots(extra=None, homes=()):
    roots = list(DEFAULT_IGNORE)
    tmpdir = os.environ.get("TMPDIR")
    if tmpdir:
        roots.append(_canon(tmpdir))
    for home in homes:
        for rel in HOME_IGNORE:
            roots.append(home + "/" + rel)
    for p in extra or ():
        if isinstance(p, str) and p.strip():
            roots.append(_canon(os.path.expanduser(p)))
    return roots


def _read_quiet_roots(homes):
    roots = list(SYSTEM_READ_QUIET)
    for home in homes:
        for rel in HOME_READ_QUIET:
            roots.append(home + "/" + rel)
    return roots


def project_root(cwd):
    """从 cwd 往上找项目根：家目录之下（不含家目录本身、不含 /）最靠上的一层带
    PROJECT_MARKERS 标记的目录。没有任何标记就返回 cwd 本身。
    取最靠上而不是最近的一层：proj/webui 有 package.json 之类的子项目标记也好、
    proj/.git 才是整个项目的边界，改 proj/README.md 不该算跨出去。"""
    cwd = _norm(cwd)
    stop = set(_session_homes(cwd) + ["/"])
    best = None
    cur = cwd
    while cur not in stop and cur != "/":
        for marker in PROJECT_MARKERS:
            try:
                if os.path.exists(os.path.join(cur, marker)):
                    best = cur
                    break
            except OSError:
                pass
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return best or cwd


def _additional_directories(cwd):
    """Claude Code 自己的 permissions.additionalDirectories（--add-dir 也写在这里）：
    用户明确说过"这些目录也算工作区"，跟 cwd 一样对待。项目级 + 用户级三个文件都看。"""
    home = _home()
    candidates = [
        os.path.join(cwd, ".claude", "settings.local.json"),
        os.path.join(cwd, ".claude", "settings.json"),
        os.path.join(home, ".claude", "settings.json"),
    ]
    dirs = []
    for path in candidates:
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        extra = (data.get("permissions") or {}).get("additionalDirectories") if isinstance(data, dict) else None
        if isinstance(extra, list):
            for d in extra:
                if isinstance(d, str) and d.strip():
                    dirs.append(_canon(os.path.join(cwd, os.path.expanduser(d))))
    return dirs


def _session_homes(cwd):
    """这个会话算"自己家"的目录：进程的 HOME，加上 cwd 所在的那个用户家目录。
    两者通常是同一个；不同的典型场景是 claude 用 root 跑、项目却放在 /home/<user>
    下——这时 /home/<user>/other-proj 是"别的项目"，不是"别的用户的家"。"""
    homes = [_home()]
    for parent in USER_HOME_PARENTS:
        if _under(cwd, parent) and cwd != parent:
            user_home = parent + "/" + cwd[len(parent) + 1:].split("/", 1)[0]
            if user_home not in homes:
                homes.append(user_home)
    if _under(cwd, "/root") and "/root" not in homes:
        homes.append("/root")
    return homes


def classify(path, cwd, allowed_roots=(), ignored_roots=None, homes=None):
    """返回 path（已归一化的绝对路径）相对于 cwd 的档位；在工作区内/被忽略返回 None。"""
    if _under(path, cwd):
        return None
    for root in allowed_roots:
        if _under(path, root):
            return None
    for root in ignored_roots if ignored_roots is not None else _ignored_roots():
        if _under(path, root):
            return None
    homes = homes if homes is not None else _session_homes(cwd)
    for home in homes:
        if _under(path, home):
            rel = path[len(home):].lstrip("/")
            first = rel.split("/", 1)[0]
            return TIER_HOME_DOTFILE if first.startswith(".") else TIER_OTHER
    if path == "/":
        return TIER_SYSTEM
    if _under(path, "/root"):
        return TIER_OTHER_USER
    for parent in USER_HOME_PARENTS:
        if path != parent and _under(path, parent):
            return TIER_OTHER_USER
    for root in SYSTEM_ROOTS:
        if _under(path, root):
            return TIER_SYSTEM
    return TIER_OTHER


def _expand(token, cwd, shell_cwd):
    """把一个 token 变成绝对路径；认不出是路径就返回 None。"""
    if not token or "\n" in token or "\t" in token or " " in token:
        return None
    if "://" in token:
        return None
    if token.startswith(("$HOME/", "${HOME}/")) or token in ("$HOME", "${HOME}"):
        token = _home() + token.split("HOME", 1)[1].lstrip("}")
    elif token.startswith(("$PWD/", "${PWD}/")) or token in ("$PWD", "${PWD}"):
        token = shell_cwd + token.split("PWD", 1)[1].lstrip("}")
    elif token.startswith("~"):
        token = os.path.expanduser(token)
        if token.startswith("~"):
            return None
    elif token.startswith("$"):
        return None  # 其它变量解析不了
    if token.startswith("/"):
        return _norm(token)
    if token in (".", "..") or token.startswith(("./", "../")) or "/" in token:
        if token.startswith("-"):
            return None
        return _norm(os.path.join(shell_cwd, token))
    return None


def _strip_heredoc(seg):
    m = _HEREDOC_RE.search(seg)
    if not m:
        return seg
    nl = seg.find("\n", m.end())
    rest = seg[m.end():] if nl == -1 else seg[m.end():nl]
    return seg[:m.start()] + " " + rest


def _tokens(seg):
    seg = _strip_heredoc(seg)
    try:
        return shlex.split(seg, posix=True)
    except ValueError:
        return seg.split()


def _iter_segments(command, depth=0):
    """按顶层 ; & | 换行 切子命令，bash -c "..." 里的再递归拆一层。复用 policy 的切分器。"""
    from . import policy  # 延迟导入：policy 在模块顶层 import 了这个模块

    for raw in policy.split_shell_segments(command):
        head = policy._normalize_head(raw)
        if not head.strip():
            continue
        m = policy._SHELL_C_RE.match(head) if depth < 3 else None
        if m:
            inner = m.group(1) if m.group(1) is not None else policy._unescape(m.group(2))
            for seg in _iter_segments(inner, depth + 1):
                yield seg
            continue
        yield head


def _bash_paths(command, cwd):
    """返回 [(abs_path, access, is_exec)]，按出现顺序；同一条命令里 cd 出去之后，后面的
    相对路径按新目录解析。"""
    out = []
    shell_cwd = cwd
    for seg in _iter_segments(command):
        toks = _tokens(seg)
        if not toks:
            continue
        cmd = os.path.basename(toks[0])
        args = toks[1:]

        if cmd in ("cd", "pushd"):
            target = next((a for a in args if not a.startswith("-")), None)
            if target is None:
                new_cwd = _home()
            elif target == "-":
                continue
            else:
                new_cwd = _expand(target, cwd, shell_cwd)
                if new_cwd is None:
                    new_cwd = _norm(os.path.join(shell_cwd, target))
            out.append((new_cwd, ACCESS_READ, False))
            shell_cwd = new_cwd
            continue

        exec_path = _expand(toks[0], cwd, shell_cwd) if "/" in toks[0] else None
        if exec_path:
            out.append((exec_path, ACCESS_READ, True))

        write_all = cmd in WRITE_ALL_CMDS
        if cmd in ("sed", "perl") and any(a.startswith("-i") or a == "--in-place" for a in args):
            write_all = True
        if cmd == "find" and "-delete" in args:
            write_all = True
        write_last = cmd in WRITE_LAST_CMDS or (cmd == "git" and args and args[0] in GIT_WRITE_LAST_SUBCMDS)
        tar_extract = tar_create = False
        if cmd == "tar" and args:
            flags = args[0].lstrip("-")
            tar_extract = "x" in flags
            tar_create = "c" in flags

        paths = []  # [(abs_path, is_last_positional_arg)]
        pending_redirect = None
        pending_flag = None
        last_positional = None
        for a in args:
            if not a.startswith("-") and not _REDIRECT_TOKEN_RE.match(a) and a not in ("<", "<<<"):
                last_positional = a
        for a in args:
            if pending_redirect is not None:
                p = _expand(a, cwd, shell_cwd)
                if p:
                    out.append((p, ACCESS_WRITE, False))
                pending_redirect = None
                continue
            if pending_flag is not None:
                flag, pending_flag = pending_flag, None
                p = _expand(a, cwd, shell_cwd)
                if p:
                    if cmd == "tar" and flag == "-C":
                        out.append((p, ACCESS_WRITE if tar_extract else ACCESS_READ, False))
                    elif cmd == "tar" and flag == "-f":
                        out.append((p, ACCESS_WRITE if tar_create else ACCESS_READ, False))
                    elif cmd == "unzip" and flag == "-d":
                        out.append((p, ACCESS_WRITE, False))
                    else:
                        paths.append((p, False))
                continue
            m = _REDIRECT_TOKEN_RE.match(a)
            if m:
                if m.group(3):
                    p = _expand(m.group(3), cwd, shell_cwd)
                    if p:
                        out.append((p, ACCESS_WRITE, False))
                else:
                    pending_redirect = True
                continue
            if a in ("<", "<<<"):
                continue
            if cmd == "tar" and a in ("-C", "-f", "--directory", "--file"):
                pending_flag = "-C" if a in ("-C", "--directory") else "-f"
                continue
            if cmd == "unzip" and a == "-d":
                pending_flag = "-d"
                continue
            if cmd == "git" and a == "-C":
                pending_flag = "-C"
                continue
            if a.startswith("-"):
                om = _OPT_ASSIGN_RE.match(a)
                if om:
                    p = _expand(om.group(1), cwd, shell_cwd)
                    if p:
                        paths.append((p, False))
                continue
            em = _ENV_ASSIGN_RE.match(a)
            if em and not a.startswith("/"):
                p = _expand(em.group(1), cwd, shell_cwd)
                if p:
                    paths.append((p, False))
                continue
            p = _expand(a, cwd, shell_cwd)
            if p:
                paths.append((p, a is last_positional))

        # cp/mv/ln 这类"最后一个参数是目标"的命令：目标是最后一个非选项参数本身，不管它
        # 长得像不像路径（`cp /etc/hosts hosts.bak` 的目标是 hosts.bak，不能因为它没带
        # 斜杠就把 /etc/hosts 当成被写的那个）。
        for p, is_last in paths:
            if write_all or (write_last and is_last):
                out.append((p, ACCESS_WRITE, False))
            else:
                out.append((p, ACCESS_READ, False))
    return out


def scan(tool_name, tool_input, cwd):
    """返回这次工具调用里所有落在工作目录之外的路径：[Hit]，按首次出现顺序，同一路径
    只留一条（写覆盖读）。cwd 为空/不是绝对路径时没法判断，返回 []。
    规则自己的 ignore_paths 白名单不在这里处理——一次 evaluate 里几条 workdir 规则共用
    同一份扫描结果，各自的白名单在 select() 里过滤。"""
    if not cwd or not isinstance(cwd, str) or not cwd.startswith("/"):
        return []
    if not isinstance(tool_input, dict):
        return []
    cwd = _norm(cwd)
    homes = _session_homes(_canon(cwd))
    # 相对路径按 hook 给的 cwd 解析（shell 真的在那里），"在不在项目里"按项目根判断
    root = project_root(cwd)
    root_real = _canon(root)
    allowed = _additional_directories(cwd)
    if root != cwd:
        allowed += _additional_directories(root)
    ignored = _ignored_roots(homes=homes)
    read_quiet = _read_quiet_roots(homes)

    candidates = []
    if tool_name == "Bash":
        command = tool_input.get("command")
        if isinstance(command, str) and command.strip():
            candidates = _bash_paths(command, cwd)
    elif tool_name in READ_TOOLS or tool_name in WRITE_TOOLS:
        access = ACCESS_WRITE if tool_name in WRITE_TOOLS else ACCESS_READ
        for key in FILE_TOOL_FIELDS:
            value = tool_input.get(key)
            if isinstance(value, str) and value.strip():
                p = _expand(value.strip(), cwd, cwd)
                if p is None and not value.startswith("-"):
                    p = _norm(os.path.join(cwd, value.strip()))
                if p:
                    candidates.append((p, access, False))
    else:
        return []

    hits = {}
    order = []
    for path, access, is_exec in candidates:
        # 先按字面路径判：在项目里 / 在忽略目录里就到此为止，不去 realpath——不然
        # `ln -sf /usr/lib/x.so /tmp/build/x.so` 这种刚建的、指向系统目录的链接会被解析
        # 成"往 /usr/lib 写"，其实写的是 /tmp。
        if _under(path, root) or any(_under(path, r) for r in ignored):
            continue
        tier = classify(_canon(path), root_real, allowed_roots=allowed, ignored_roots=ignored, homes=homes)
        if tier is None:
            continue
        if is_exec and tier == TIER_SYSTEM:
            continue  # /usr/bin/python3 这种是在跑系统里的程序，不算访问系统目录
        # 只读系统目录/缓存目录里的读：跑程序、查库、看头文件，不算事。按字面路径判，不
        # 追符号链接——/etc/os-release 软链到 /usr/lib/os-release，但字面在 /etc，该报还得报。
        if access == ACCESS_READ and any(_under(path, r) for r in read_quiet):
            continue
        if path in hits:
            if access == ACCESS_WRITE:
                hits[path].access = ACCESS_WRITE
            continue
        hits[path] = Hit(path, tier, access)
        order.append(path)
    return [hits[p] for p in order]


def select(hits, scopes=None, access=None, ignore_paths=None):
    """按规则里的 scopes（档位列表）、access（read/write/any）和 ignore_paths（额外白名单，
    支持 ~）过滤 scan() 的结果。"""
    scopes = set(scopes) if scopes else set(ALL_TIERS)
    ignored = [_canon(os.path.expanduser(p)) for p in ignore_paths or () if isinstance(p, str) and p.strip()]
    return [
        h for h in hits
        if h.tier in scopes
        and (not access or access == "any" or h.access == access)
        # 字面路径和 realpath 两个都比：ignore_paths 写的是 /etc，/etc/os-release 在
        # 有些发行版上是指向 /usr/lib/os-release 的符号链接，只比 realpath 就漏了。
        and not any(_under(h.path, root) or _under(_canon(h.path), root) for root in ignored)
    ]


def describe(hits, limit=5):
    shown = [h.display for h in hits[:limit]]
    if len(hits) > limit:
        shown.append("…(+{})".format(len(hits) - limit))
    return ", ".join(shown)
