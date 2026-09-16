"use strict";
// 规则表的元信息（title/desc 中英文、风险、动作）——给"AI 审批台"和审批历史用：
// 光看规则 id（比如 git_force_push）人不知道要确认的是什么，得配一句通俗解释。
// 读的是用户目录下那份 rules.json（~/.cc-monitor/rules.json，Python 侧 ensure_config()
// 会把新版默认规则合并进去），读不到就退回仓库里的 default_rules.json。只读，不写。
const fs = require("fs");
const os = require("os");
const path = require("path");

const CACHE_MS = 5000;
let cache = { at: 0, byId: {} };

function userRulesPath() {
  const home = process.env.CC_MONITOR_HOME || path.join(os.homedir(), ".cc-monitor");
  return path.join(home, "rules.json");
}

function defaultRulesPath() {
  return path.join(__dirname, "..", "..", "cc_monitor", "default_rules.json");
}

function readRules() {
  for (const p of [userRulesPath(), defaultRulesPath()]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // 下一个候选
    }
  }
  return [];
}

// 返回 { <rule id>: { title, desc, title_en, desc_en, risk, action } }
function ruleMeta() {
  const now = Date.now();
  if (now - cache.at < CACHE_MS) return cache.byId;
  const byId = {};
  for (const r of readRules()) {
    if (!r || typeof r.id !== "string") continue;
    byId[r.id] = {
      title: r.title || null,
      desc: r.desc || null,
      title_en: r.title_en || null,
      desc_en: r.desc_en || null,
      risk: r.risk || null,
      action: r.action || null,
    };
  }
  cache = { at: now, byId };
  return byId;
}

module.exports = { ruleMeta };
