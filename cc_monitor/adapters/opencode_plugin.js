// CC-Monitor 的 OpenCode 插件：把每次工具调用转发给 CC-Monitor-hook 做规则判定/审批/记录。
// 由 install.py --agent opencode 复制到 ~/.config/opencode/plugins/cc-monitor.js（或项目的
// .opencode/plugins/）。HOOK_BIN 由 install.py 写入；也可以用环境变量 CC_MONITOR_HOOK 覆盖。
//
// tool.execute.before 里同步 spawn，hook 返回 2 就 throw——OpenCode 会把异常当作工具执行失败
// 反馈给模型，等价于拒绝。审批（confirm 类规则）要等人点按钮，最长 90 秒，所以 timeout 给足。
const { spawnSync } = require("child_process");

const HOOK_BIN = process.env.CC_MONITOR_HOOK || "__CC_MONITOR_HOOK_BIN__";
const TIMEOUT_MS = 100 * 1000;

function runHook(mode, payload) {
  const r = spawnSync(HOOK_BIN, [mode, "--agent", "opencode"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { code: r.status, stderr: r.stderr || "", error: r.error };
}

export const CCMonitorPlugin = async ({ directory, worktree }) => {
  const cwd = worktree || directory || process.cwd();
  return {
    "tool.execute.before": async (input, output) => {
      const r = runHook("pre", {
        hook_event_name: "tool.execute.before",
        session_id: input.sessionID,
        call_id: input.callID,
        tool_name: input.tool,
        tool_input: output.args || {},
        cwd,
      });
      if (r.code === 2) {
        throw new Error(r.stderr.trim() || "[CC-Monitor] operation blocked");
      }
      // 其它非 0（hook 自身出错）fail-open，跟 Claude Code 那边"绝不因监测器 bug 卡住 agent"一致。
    },
    "tool.execute.after": async (input, output) => {
      runHook("post", {
        hook_event_name: "tool.execute.after",
        session_id: input.sessionID,
        call_id: input.callID,
        tool_name: input.tool,
        tool_input: input.args || {},
        tool_response: { title: output.title, output: typeof output.output === "string" ? output.output.slice(0, 4000) : output.output },
        cwd,
      });
    },
  };
};

export default CCMonitorPlugin;
