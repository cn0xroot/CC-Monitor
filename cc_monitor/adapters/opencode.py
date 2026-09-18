"""OpenCode 没有命令行 hook，只有 JS 插件（tool.execute.before / tool.execute.after）。
cc_monitor/adapters/opencode_plugin.js 是那个插件：把每次工具调用同步 spawn 一次
`CC-Monitor-hook pre --agent opencode`，stdin 喂下面这种 JSON，退出码 2 就 throw 阻断：
    {"hook_event_name":"tool.execute.before","session_id":...,"tool_name":"bash",
     "tool_input":{...args},"cwd":...,"call_id":...}
工具名是小写（bash/read/write/edit/glob/grep/webfetch/task/...），字段是 camelCase（filePath），
注册表里有映射。
"""
from . import base, claude

AGENT = "opencode"
BLOCK_EXIT_CODE = 2


def parse(mode, data, agent=AGENT):
    if mode in ("pre", "post"):
        c = base.call(agent, data.get("tool_name", ""), data.get("tool_input", {}) or {},
                      tool_response=data.get("tool_response"))
        ev = base.event(agent, mode, data, calls=[c])
        if data.get("call_id"):
            ev["extra"]["call_id"] = data["call_id"]
        return ev
    return claude.parse(mode, data, agent=agent)


def emit_pre(decision):
    # 插件只看退出码：2 = 阻断（stderr 当理由抛给模型），0 = 放行。没有"跳过原生确认"的语义。
    if decision["decision"] == "blocked":
        return None, BLOCK_EXIT_CODE
    return None, 0


def emit_permission(behavior):
    return None


def hook_config_entries(hook_bin, agent, events):
    return {}  # 插件文件本身就是配置，见 install.py 的 opencode-plugin 分支
