"use strict";
// 账号资料（姓名/邮箱/组织/套餐）——不是走 Anthropic 的接口，是 Claude Code 自己
// 落在本地的全局配置文件 ~/.claude.json 里的 oauthAccount 字段，ccstatusline 的
// "Claude Account Email" 挂件读的就是这个文件（反编译它的 dist 包确认过路径和字段名）。
// 纯本地文件读取，不涉及任何网络请求或凭证材料——oauthAccount 里没有 token，
// 只有账号资料本身。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readClaudeOauth } = require("./credentials");

const CLAUDE_JSON_PATH = path.join(os.homedir(), ".claude.json");

function getAccountInfo() {
  const info = {};
  try {
    const raw = fs.readFileSync(CLAUDE_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const oa = parsed?.oauthAccount;
    if (oa) {
      info.displayName = oa.displayName || oa.fullName || null;
      info.email = oa.emailAddress || null;
      info.organizationName = oa.organizationName || null;
      info.organizationRole = oa.organizationRole || null;
      info.organizationType = oa.organizationType || null;
      info.organizationRateLimitTier = oa.organizationRateLimitTier || null;
      info.accountCreatedAt = oa.accountCreatedAt || null;
      info.subscriptionCreatedAt = oa.subscriptionCreatedAt || null;
      info.billingType = oa.billingType || null;
    }
  } catch (e) {
    // 文件不存在/读不了/格式不对——账号信息留空就好，不当错误处理
    // （usage.js 那边已经会在读不到登录凭证时单独报错）
  }
  // subscriptionType/rateLimitTier 是 OAuth 凭证里的字段（Linux 在 .credentials.json，
  // macOS 在钥匙串，见 lib/credentials.js），跟 oauthAccount 是两个不同的来源，两边字段
  // 不完全重叠（比如这边这两个是 OAuth token 申请时记录的档位快照，可能跟
  // oauthAccount.organizationType 不是同一个东西）。读不到就留空。
  const oauth = readClaudeOauth();
  if (oauth) {
    info.subscriptionType = oauth.subscriptionType || null;
    info.rateLimitTier = oauth.rateLimitTier || null;
  }
  return info;
}

module.exports = { getAccountInfo };
