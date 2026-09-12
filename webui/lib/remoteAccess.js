"use strict";
const fs = require("fs");
const path = require("path");
const { dbPath } = require("./audit");

// 是否允许"本机以外"的设备访问这个 Web UI——默认关（只有 127.0.0.1/::1 能进来）。
// 跟 audit_state.json 一个存法：一个小 JSON 文件，服务端每次请求都读一下当前值，
// 在 UI 上点一下开关立刻生效，不用重启进程。
function stateFile() {
  return path.join(path.dirname(dbPath()), "remote_access_state.json");
}

function getState() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (typeof data.allowRemote === "boolean") return data;
  } catch (e) {
    // 文件不存在/损坏都当作默认值：不允许远程访问
  }
  return { allowRemote: false, changedAt: null };
}

function setState(allowRemote) {
  const dir = path.dirname(stateFile());
  fs.mkdirSync(dir, { recursive: true });
  const data = { allowRemote: !!allowRemote, changedAt: new Date().toISOString() };
  fs.writeFileSync(stateFile(), JSON.stringify(data));
  return data;
}

// 判断一个请求的来源地址是不是"本机"——IPv4 127.0.0.1、IPv6 ::1，以及 Node 在双栈
// socket 上常见的 IPv4-mapped IPv6 写法 ::ffff:127.0.0.1，都算本机。
function isLocalAddress(addr) {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

module.exports = { getState, setState, isLocalAddress };
