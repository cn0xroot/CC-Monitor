"use strict";
// Claude Code 自己保存的 OAuth 凭证（claudeAiOauth.accessToken / subscriptionType / ...）。
// 存放位置分平台：
//   - Linux：明文文件 ~/.claude/.credentials.json
//   - macOS：**不落文件**，写进登录钥匙串（login.keychain）里一条 generic password，
//     service 名固定是 "Claude Code-credentials"，内容就是同一份 JSON 字符串。
// 全新的 Mac 上 ~/.claude/.credentials.json 根本不会存在，只读文件的话额度/套餐永远
// 查不到——这跟有没有装 ccstatusline 完全无关（我们不调用 ccstatusline，只是复刻它读
// 凭证的逻辑，而它在 macOS 上走的正是 `security find-generic-password` 这条路）。
// 顺序：先看文件（某些老版本/手动迁移的 Mac 上也可能有），没有再查钥匙串。
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

function readFromKeychain() {
  if (os.platform() !== "darwin") return null;
  try {
    // 第一次调用时 macOS 可能弹一个"node 想访问钥匙串"的系统确认框（点"始终允许"之后
    // 不再弹）——这是 macOS 自己的 ACL 机制，不是我们能绕过的。给个短超时，免得那个框
    // 没人点的时候把 /api/usage 请求一直挂着。
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (e) {
    return null;
  }
}

// 返回解析好的 claudeAiOauth 对象，或 null。
function readClaudeOauth() {
  for (const raw of [readFromFile(), readFromKeychain()]) {
    if (!raw) continue;
    try {
      const oauth = JSON.parse(raw)?.claudeAiOauth;
      if (oauth && typeof oauth === "object") return oauth;
    } catch (e) {
      // 内容不是预期 JSON，试下一个来源
    }
  }
  return null;
}

// 给错误提示用：告诉用户这台机器上凭证应该在哪
function credentialsLocationHint() {
  return os.platform() === "darwin"
    ? `~/.claude/.credentials.json 或钥匙串 "${KEYCHAIN_SERVICE}"`
    : "~/.claude/.credentials.json";
}

module.exports = { readClaudeOauth, credentialsLocationHint, CREDENTIALS_PATH, KEYCHAIN_SERVICE };
