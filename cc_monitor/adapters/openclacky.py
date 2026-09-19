"""OpenClacky（Ruby gem）的应用层 hook 协议。

OpenClacky 读 ~/.clacky/hooks.yml，同一个事件可以挂多条 hook。两个事件走的协议不一样：

  before_tool_use——用 rewrite 协议（`type: rewrite`，只有这个事件支持）。payload 是 Claude Code
  PreToolUse 的形状（session_id / cwd / permission_mode / hook_event_name / tool_name / tool_input），
  exit 2 时理由 stderr 优先于 stdout。形状虽然一样，工具名却还是 Clacky 自己的（terminal / write /
  file_reader…），不能直接丢给 claude.parse——那边认为工具名已经是规范词汇，会原样透传，见
  _parse_rewrite。

  after_tool_use——只能用 simple 协议，payload 换成 {event, tool: {name, arguments}, result}，
  arguments 是 Ruby 那边 JSON.generate 出来的字符串，得自己拆。simple 协议的 payload 里没有
  session_id / cwd，cwd 用 hook 进程自己的（Open3.popen3 不改子进程 cwd，也就是 agent 进程的）。

工具名是小写 snake_case（terminal / file_reader / write / edit / …），注册表里有映射。路径字段叫
path，注册表把它映射成 file_path（跟 grok-cli 一个做法），免得 format.py 这类只认 file_path 的
下游拿到空路径；command / query / questions 本来就跟 Claude 词汇同名，不用改名。
"""
import json
import os

from . import base, claude

AGENT = "openclacky"
# 理由写 stderr：rewrite 协议下 stderr 优先，simple 协议下 exit 2 也认。
BLOCK_EXIT_CODE = 2


def parse(mode, data, agent=AGENT):
    if not isinstance(data, dict):
        data = {}
    # rewrite 协议带 hook_event_name（Claude Code 形状），simple 协议带 event。
    if "hook_event_name" in data:
        return _parse_rewrite(mode, data, agent)
    if mode in ("pre", "post"):
        return _parse_simple(mode, data, agent)
    return claude.parse(mode, data, agent=agent)


def _parse_rewrite(mode, data, agent):
    """rewrite 协议的 payload 形状跟 Claude Code 的 PreToolUse 一样，但工具名是 Clacky 的
    （terminal / write / file_reader…），所以不能直接甩给 claude.parse：那边按定义认为工具名
    已经是规范词汇，会原样透传，规则表里按 Bash/Write 写的条目一条都匹配不上。"""
    native_tool = data.get("tool_name") or ""
    native_input = data.get("tool_input") or {}
    call = base.call(agent, native_tool, _seen_input(native_tool, native_input),
                     tool_response=data.get("tool_response"))
    return base.event(agent, mode, data, calls=[call])


def _seen_input(native_tool, native_input):
    """terminal 的交互式调用（session_id + input）是往已经开着的 shell 里写"下半条命令行"，
    rm -rf / 从这条路进来照样得被规则看到——Clacky 的 input 对 Bash 规则来说就是 command。
    command 已经有了就不动，poll/空输入（input 为空）也不动。"""
    if not isinstance(native_input, dict) or native_tool != "terminal":
        return native_input
    if native_input.get("command") or not native_input.get("input"):
        return native_input
    merged = dict(native_input)
    merged["command"] = str(native_input["input"]).rstrip("\n")
    return merged


def _parse_simple(mode, data, agent):
    tool = data.get("tool")
    if not isinstance(tool, dict):
        tool = {}
    call = base.call(agent, tool.get("name") or "",
                     _seen_input(tool.get("name") or "", _arguments(tool.get("arguments"))),
                     tool_response=data.get("result"))
    return base.event(agent, mode, data, calls=[call], cwd=os.getcwd())


def _arguments(raw):
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            return parsed
    return {}


def emit_pre(decision):
    # rewrite 协议：2 = 阻断（stderr 当理由显示给模型），0 = 放行（stdout 留空 = 不改写工具入参）。
    if decision["decision"] == "blocked":
        return None, BLOCK_EXIT_CODE
    return None, 0


def emit_permission(behavior):
    return None


def hook_config_entries(hook_bin, agent, events):
    return {}  # Clacky 的配置是 YAML，由 install.py 的 clacky-hooks 分支直接生成
