"use strict";
// Claude Code 自己保存的 OAuth 凭证（claudeAiOauth.accessToken / subscriptionType / ...）。
// 存放位置分平台：
//   - Linux：明文文件 ~/.claude/.credentials.json
//   - macOS：**不落文件**，写进登录钥匙串（login.keychain）里一条 generic password，
//     service 名固定是 "Claude Code-credentials"，内容就是同一份 JSON 字符串。
// 全新的 Mac 上 ~/.claude/.credentials.json 根本不会存在，只读文件的话额度/套餐永远
// 查不到——这跟有没有装 ccstatusline 完全无关（我们不调用 ccstatusline，只是复刻它读
// 凭证的逻辑，而它在 macOS 上走的正是 `security find-generic-password` 这条路）。
//
// 钥匙串里同一个 service 可能有**多条**记录（acct 不同）：比如 sudo 跑过一次 Claude Code
// 就会多出一条 acct=root 的，之后没人刷新它，token 很快过期。`security -s` 不带 `-a` 只返回
// 第一条匹配，撞上那条过期的就会一直 "usage API 返回 401"。所以：
//   1. 钥匙串先按当前用户名（-a）查，查不到再退回不带 -a；
//   2. 所有来源都解析出来后，优先挑没过期的（expiresAt 在未来）；全过期就挑过期最晚的那条，
//      由调用方看 expiresAt 决定怎么提示（套餐类型这种字段过期了照样能用）。
// 只读；任何一步失败都返回 null，由调用方自己决定怎么报错。
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const KEYCHAIN_SERVICE = "Claude Code-credentials";

function readFromFile() {
  try {
    return fs.readFileSync(CREDENTIALS_PATH, "utf8");
  } catch (e) {
    return null;
  }
}

function currentUsername() {
  try {
    return os.userInfo().username || null;
  } catch (e) {
    return process.env.USER || null;
  }
}

function keychainLookup(extraArgs) {
  try {
    // 第一次调用时 macOS 可能弹一个"node 想访问钥匙串"的系统确认框（点"始终允许"之后
    // 不再弹）——这是 macOS 自己的 ACL 机制，不是我们能绕过的。给个短超时，免得那个框
    // 没人点的时候把 /api/usage 请求一直挂着。
    return execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, ...extraArgs, "-w"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch (e) {
    return null;
  }
}

// 返回 0~2 条原始 JSON 字符串：先当前用户那条，再不带 -a 的默认那条（两者可能相同，去重）。
function readFromKeychain() {
  if (os.platform() !== "darwin") return [];
  const out = [];
  const user = currentUsername();
  if (user) {
    const mine = keychainLookup(["-a", user]);
    if (mine) out.push(mine);
  }
  const any = keychainLookup([]);
  if (any && !out.includes(any)) out.push(any);
  return out;
}

function parseOauth(raw) {
  if (!raw) return null;
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    return oauth && typeof oauth === "object" ? oauth : null;
  } catch (e) {
    return null; // 内容不是预期 JSON
  }
}

function isExpired(oauth, now = Date.now()) {
  // 没有 expiresAt 的旧格式当作未过期，交给接口自己判断
  return typeof oauth?.expiresAt === "number" && oauth.expiresAt <= now;
}

// 从多份候选里挑：优先未过期的（按来源顺序），否则过期最晚的那份，都没有则 null。
function pickOauth(candidates, now = Date.now()) {
  const parsed = candidates.map(parseOauth).filter(Boolean);
  const valid = parsed.find((o) => !isExpired(o, now));
  if (valid) return valid;
  return parsed.reduce((best, o) => (!best || (o.expiresAt || 0) > (best.expiresAt || 0) ? o : best), null);
}

// 返回解析好的 claudeAiOauth 对象，或 null。
function readClaudeOauth() {
  return pickOauth([readFromFile(), ...readFromKeychain()]);
}

// 给错误提示用：告诉用户这台机器上凭证应该在哪
function credentialsLocationHint() {
  return os.platform() === "darwin"
    ? `~/.claude/.credentials.json 或钥匙串 "${KEYCHAIN_SERVICE}"`
    : "~/.claude/.credentials.json";
}

module.exports = {
  readClaudeOauth,
  credentialsLocationHint,
  isExpired,
  pickOauth,
  CREDENTIALS_PATH,
  KEYCHAIN_SERVICE,
};
