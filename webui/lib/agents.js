"use strict";
// Agent 注册表的只读视图：跟 Python 那边（cc_monitor/registry.py）读的是同一批
// cc_monitor/agents/*.json，外加用户放在 $CC_MONITOR_HOME/agents/ 下的覆盖文件。
// Web UI 只需要 id / 显示名 / 有没有应用层 hook / 启动命令这几样，别的字段不碰。
const fs = require("fs");
const os = require("os");
const path = require("path");

const BUILTIN_DIR = path.join(__dirname, "..", "..", "cc_monitor", "agents");

function userDir() {
  const home = process.env.CC_MONITOR_HOME || path.join(os.homedir(), ".cc-monitor");
  return path.join(home, "agents");
}

function readDir(dir, into) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch (e) {
    return;
  }
  for (const name of names) {
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (spec && spec.id) into.set(spec.id, { ...(into.get(spec.id) || {}), ...spec });
    } catch (e) {
      // 坏文件跳过，跟 Python 那边一致
    }
  }
}

let cache = null;
let cacheAt = 0;

function list() {
  const now = Date.now();
  if (cache && now - cacheAt < 30 * 1000) return cache;
  const into = new Map();
  readDir(BUILTIN_DIR, into);
  readDir(userDir(), into);
  cache = [...into.values()].map((spec) => ({
    id: spec.id,
    display: spec.display || spec.id,
    hasHooks: !!spec.hooks,
    launchCommand: spec.launch_command || null,
    envStripPrefixes: spec.env_strip_prefixes || [],
    exeBasenames: (spec.process && spec.process.exe_basename) || [],
    argvPatterns: ((spec.process && spec.process.argv_patterns) || [])
      .map((p) => {
        try {
          return new RegExp(p);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean),
  }));
  cacheAt = now;
  return cache;
}

function get(id) {
  return list().find((a) => a.id === id) || null;
}

// 跟 Python 的 registry.classify_process() 同一套判断（少了 comm，ps 的 args 里没有）：
// 可执行文件名精确匹配优先，再按 argv 正则；都不是返回 null。
function classifyArgs(args) {
  const argv0 = (args || "").trim().split(/\s+/)[0] || "";
  const base = argv0.split("/").pop();
  const agents = list();
  for (const a of agents) {
    if (base && a.exeBasenames.includes(base)) return a.id;
  }
  for (const a of agents) {
    if (a.argvPatterns.some((re) => re.test(args || ""))) return a.id;
  }
  return null;
}

module.exports = { list, get, classifyArgs };
