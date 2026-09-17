"use strict";
const fs = require("fs");
const path = require("path");
const { dbPath } = require("./audit");

// 跟 Python 那边的 cc_monitor/audit_state.py 读写的是同一个文件、同一套 JSON 结构——
// hook 每次调用都会读它来决定这次要不要真的判定/拦截，这里的 REST 接口只是给 Web UI
// 一个读写这个文件的入口，状态本身以 hook 那边的解释为准。
function stateFile() {
  return path.join(path.dirname(dbPath()), "audit_state.json");
}

// 落盘用的规范值，跟 Python 那边的 audit_state.VALID_STATES 必须一致。
const VALID_STATES = ["running", "paused", "stopped"];

// 别名 -> 规范值，跟 Python 那边的 audit_state.STATE_ALIASES 保持同步。
// permissive 是 paused 这一档对外主推的名字（照常判定、照常记录，只是不拦截、不弹确认框），
// 取名参考 SELinux 的 permissive / AppArmor 的 complain。磁盘上仍然写 paused，这样老版本
// 和任何直接读这个文件的脚本都不会因为改名而失效。
const STATE_ALIASES = {
  permissive: "paused",
  observe: "paused",
  "log-only": "paused",
  log_only: "paused",
  enforcing: "running",
  enforce: "running",
  disabled: "stopped",
  off: "stopped",
};

function normalizeState(state) {
  if (typeof state !== "string") return null;
  const s = state.trim().toLowerCase();
  if (VALID_STATES.includes(s)) return s;
  return STATE_ALIASES[s] || null;
}

function getState() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (VALID_STATES.includes(data.state)) return data;
  } catch (e) {
    // 文件不存在或损坏都当作默认的 running
  }
  return { state: "running", changedAt: null };
}

function setState(state) {
  const canonical = normalizeState(state);
  if (!canonical) {
    throw new Error(
      `state 必须是 ${VALID_STATES.join("/")} 之一（也接受别名 ${Object.keys(STATE_ALIASES).join("/")}）`
    );
  }
  const dir = path.dirname(stateFile());
  fs.mkdirSync(dir, { recursive: true });
  const data = { state: canonical, changedAt: new Date().toISOString() };
  fs.writeFileSync(stateFile(), JSON.stringify(data));
  return data;
}

module.exports = { getState, setState, normalizeState, VALID_STATES, STATE_ALIASES };
