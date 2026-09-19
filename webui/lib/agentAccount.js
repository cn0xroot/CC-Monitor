"use strict";
// 其它 agent 的"账号 & 环境"面板数据（首页/状态页那块原来只认 Anthropic）。
//
// 各家都没有 Anthropic 那种本地额度接口，所以这里给的是：这家 agent 装在哪、什么版本、
// 用什么账号 / 凭证类型登录、配置文件与 hook 接入状态、库里有多少会话、用过哪些模型。
// 凭证本身（token / api key）一律不读出来，只报"有 / 没有"和末几位。
// 每家的取法是按它们的公开文件布局写的，跟接入本身一样是实验性的：文件不存在就那一项不显示。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const agentsRegistry = require("./agents");
const audit = require("./audit");
const transcript = require("./transcript");

const H = os.homedir();
const P = (...p) => path.join(H, ...p);

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (e) {
    return false;
  }
}
function which(cmd) {
  if (!cmd) return null;
  try {
    return execFileSync("which", [cmd], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch (e) {
    return null;
  }
}
const versionCache = new Map();
function version(cmd) {
  if (!cmd) return null;
  const hit = versionCache.get(cmd);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.v;
  let v = null;
  try {
    v = execFileSync(cmd, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")[0].trim().slice(0, 80) || null;
  } catch (e) {
    v = null;
  }
  versionCache.set(cmd, { v, at: Date.now() });
  return v;
}
function tail4(s) {
  return typeof s === "string" && s.length >= 8 ? `…${s.slice(-4)}` : null;
}
// JWT 的 payload 段（不验签，只是读 email 这种展示字段）
function jwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch (e) {
    return null;
  }
}

// 各家的凭证 / 账号线索。返回 {rows: [{key, value, sensitive}], quotaNote}
const EXTRACTORS = {
  "antigravity-cli": () => {
    const rows = [];
    const acc = readJson(P(".gemini", "google_accounts.json"));
    const active = acc && (acc.active || (Array.isArray(acc.accounts) && acc.accounts[0] && acc.accounts[0].email));
    if (active) rows.push({ key: "account", value: String(active), sensitive: true });
    const settings = readJson(P(".gemini", "settings.json"));
    const auth = settings && settings.security && settings.security.auth && settings.security.auth.selectedType;
    if (auth) rows.push({ key: "authType", value: auth });
    if (exists(P(".gemini", "antigravity-cli", "antigravity-oauth-token"))) rows.push({ key: "credential", value: "oauth-token" });
    const mcp = readJson(P(".gemini", "antigravity-cli", "mcp_config.json"));
    if (mcp && mcp.mcpServers) rows.push({ key: "mcpServers", value: String(Object.keys(mcp.mcpServers).length) });
    return { rows, quotaNote: "noQuotaApi" };
  },
  "gemini-cli": () => {
    const rows = [];
    const acc = readJson(P(".gemini", "google_accounts.json"));
    const active = acc && (acc.active || (Array.isArray(acc.accounts) && acc.accounts[0] && acc.accounts[0].email));
    if (active) rows.push({ key: "account", value: String(active), sensitive: true });
    const settings = readJson(P(".gemini", "settings.json"));
    const auth = settings && settings.security && settings.security.auth && settings.security.auth.selectedType;
    if (auth) rows.push({ key: "authType", value: auth });
    if (exists(P(".gemini", "oauth_creds.json"))) rows.push({ key: "credential", value: "oauth_creds.json" });
    if (process.env.GEMINI_API_KEY) rows.push({ key: "apiKey", value: tail4(process.env.GEMINI_API_KEY) || "set", sensitive: true });
    return { rows, quotaNote: "noQuotaApi" };
  },
  codex: () => {
    const rows = [];
    const auth = readJson(P(".codex", "auth.json"));
    if (auth) {
      const idt = auth.tokens && auth.tokens.id_token ? jwtPayload(auth.tokens.id_token) : null;
      if (idt && idt.email) rows.push({ key: "account", value: idt.email, sensitive: true });
      const plan = idt && idt["https://api.openai.com/auth"] && idt["https://api.openai.com/auth"].chatgpt_plan_type;
      if (plan) rows.push({ key: "plan", value: plan });
      if (auth.OPENAI_API_KEY) rows.push({ key: "apiKey", value: tail4(auth.OPENAI_API_KEY) || "set", sensitive: true });
      rows.push({ key: "credential", value: auth.tokens ? "chatgpt-oauth" : "api-key" });
    } else if (process.env.OPENAI_API_KEY) {
      rows.push({ key: "apiKey", value: tail4(process.env.OPENAI_API_KEY) || "set", sensitive: true });
    }
    const cfg = P(".codex", "config.toml");
    if (exists(cfg)) {
      const text = fs.readFileSync(cfg, "utf8");
      const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(text);
      if (m) rows.push({ key: "configuredModel", value: m[1] });
      const hooksOn = /^\s*hooks\s*=\s*true/m.test(text) || /^\s*codex_hooks\s*=\s*true/m.test(text);
      rows.push({ key: "hooksFeature", value: hooksOn ? "true" : /hooks\s*=\s*false/.test(text) ? "false" : "default" });
    }
    return { rows, quotaNote: "noQuotaApi" };
  },
  "grok-cli": () => {
    const rows = [];
    const us = readJson(P(".grok", "user-settings.json")) || {};
    if (us.apiKey) rows.push({ key: "apiKey", value: tail4(us.apiKey) || "set", sensitive: true });
    else if (process.env.GROK_API_KEY) rows.push({ key: "apiKey", value: tail4(process.env.GROK_API_KEY) || "set", sensitive: true });
    if (us.baseURL || process.env.GROK_BASE_URL) rows.push({ key: "baseUrl", value: us.baseURL || process.env.GROK_BASE_URL });
    if (us.defaultModel || us.model) rows.push({ key: "configuredModel", value: us.defaultModel || us.model });
    return { rows, quotaNote: "noQuotaApi" };
  },
  opencode: () => {
    const rows = [];
    const auth = readJson(P(".local", "share", "opencode", "auth.json"));
    if (auth && typeof auth === "object") rows.push({ key: "providers", value: Object.keys(auth).join(", ") || "-" });
    const cfg = readJson(P(".config", "opencode", "opencode.json"));
    if (cfg && cfg.model) rows.push({ key: "configuredModel", value: String(cfg.model) });
    return { rows, quotaNote: "noQuotaApi" };
  },
  zcode: () => {
    const rows = [];
    const pc = readJson(P(".zcode", "v2", "provider_config.json"));
    if (pc && typeof pc === "object") {
      const names = Object.keys(pc.providers || pc).slice(0, 6);
      if (names.length) rows.push({ key: "providers", value: names.join(", ") });
    }
    const cfg = readJson(P(".zcode", "cli", "config.json"));
    if (cfg && cfg.hooks) rows.push({ key: "hooksFeature", value: cfg.hooks.enabled ? "true" : "false" });
    return { rows, quotaNote: "noQuotaApi" };
  },
  cursor: () => ({ rows: [], quotaNote: "noQuotaApi" }),
  aider: () => {
    const rows = [];
    for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"]) {
      if (process.env[k]) rows.push({ key: "apiKey", value: `${k} ${tail4(process.env[k]) || ""}`.trim(), sensitive: true });
    }
    return { rows, quotaNote: "noQuotaApi" };
  },
};

function hookInstalled(spec) {
  const cfg = spec && spec.hooksConfigUserPath;
  if (!cfg) return null;
  try {
    return fs.readFileSync(cfg.replace(/^~(?=\/|$)/, H), "utf8").includes("CC-Monitor-hook");
  } catch (e) {
    return false;
  }
}

function info(agentId) {
  const spec = agentsRegistry.get(agentId);
  if (!spec) return null;
  const bin = which(spec.launchCommand);
  const rows = [];
  rows.push({ key: "status", value: spec.status });
  if (bin) rows.push({ key: "binary", value: bin });
  const v = version(spec.launchCommand);
  if (v) rows.push({ key: "version", value: v });
  if (spec.hooksConfigUserPath) {
    const hooked = hookInstalled(spec);
    rows.push({ key: "hookConfig", value: spec.hooksConfigUserPath });
    rows.push({ key: "hookInstalled", value: hooked === null ? "-" : hooked ? "yes" : "no" });
  } else {
    rows.push({ key: "hookInstalled", value: "n/a" });
  }
  const extra = EXTRACTORS[agentId] ? EXTRACTORS[agentId]() : { rows: [], quotaNote: "noQuotaApi" };
  rows.push(...extra.rows);
  // 库里的活动：会话数、最近活动、见过的模型
  const sessions = audit.listSessions(200, { agent: agentId });
  rows.push({ key: "sessions", value: String(sessions.length) });
  if (sessions[0]) rows.push({ key: "lastActivity", value: sessions[0].last_ts });
  const models = new Set();
  for (const s of sessions.slice(0, 20)) {
    const m = s.transcript_path ? transcript.getModel(s.transcript_path) : null;
    if (m) models.add(m);
  }
  if (models.size) rows.push({ key: "modelsSeen", value: [...models].join(", ") });
  return { agent: agentId, display: spec.display, status: spec.status, rows, quotaNote: extra.quotaNote };
}

module.exports = { info };
