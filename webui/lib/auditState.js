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

const VALID_STATES = ["running", "paused", "stopped"];

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
  if (!VALID_STATES.includes(state)) throw new Error(`state 必须是 ${VALID_STATES.join("/")} 之一`);
  const dir = path.dirname(stateFile());
  fs.mkdirSync(dir, { recursive: true });
  const data = { state, changedAt: new Date().toISOString() };
  fs.writeFileSync(stateFile(), JSON.stringify(data));
  return data;
}

module.exports = { getState, setState };
