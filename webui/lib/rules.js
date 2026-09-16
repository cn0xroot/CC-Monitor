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

function readJson(p) {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function readRules() {
  return readJson(userRulesPath()) || readJson(defaultRulesPath()) || [];
}

// 返回 { <rule id>: { title, desc, title_en, desc_en, risk, action } }
function ruleMeta() {
  const now = Date.now();
  if (now - cache.at < CACHE_MS) return cache.byId;
  // 用户 rules.json 里被改过的规则，Python 的默认规则合并会刻意跳过（不覆盖用户的
  // 修改），于是这些规则拿不到新版加的 title/desc。展示时按 id 回退到仓库内置默认
  // 表的文案——只影响显示，绝不写回用户文件。
  const fallback = {};
  for (const r of readJson(defaultRulesPath()) || []) {
    if (r && typeof r.id === "string") fallback[r.id] = r;
  }
  const byId = {};
  for (const r of readRules()) {
    if (!r || typeof r.id !== "string") continue;
    const d = fallback[r.id] || {};
    byId[r.id] = {
      title: r.title || d.title || null,
      desc: r.desc || d.desc || null,
      title_en: r.title_en || d.title_en || null,
      desc_en: r.desc_en || d.desc_en || null,
      risk: r.risk || null,
      action: r.action || null,
    };
  }
  cache = { at: now, byId };
  return byId;
}

module.exports = { ruleMeta };
