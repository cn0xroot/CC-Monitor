"use strict";
// 账号资料（姓名/邮箱/组织/套餐）——不是走 Anthropic 的接口，是 Claude Code 自己
// 落在本地的全局配置文件 ~/.claude.json 里的 oauthAccount 字段，ccstatusline 的
// "Claude Account Email" 挂件读的就是这个文件（反编译它的 dist 包确认过路径和字段名）。
// 纯本地文件读取，不涉及任何网络请求或凭证材料——oauthAccount 里没有 token，
// 只有账号资料本身。
const { execFileSync } = require("child_process");
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
      // 标识符：本身没有使用价值，但排查"两个终端为什么互相看不到"这类问题时要用来对齐
      // 身份。默认显示，"隐藏敏感信息"会把它们跟姓名/邮箱/组织一起打码（见 app.js）。
      info.accountUuid = oa.accountUuid || null;
      info.organizationUuid = oa.organizationUuid || null;
    }
    // 下面几个在 ~/.claude.json 顶层，不在 oauthAccount 里，是"这台机器上的 Claude Code
    // 处于什么状态"而不是"账号是谁"——对本工具尤其有用：hook 依赖 Claude Code 的 hook
    // 接口，版本不对是排查 hook 失灵的第一件事；MCP server 是供应链面；自动更新决定被
    // 监控的程序会不会在脚下换版本；安装方式决定配置和二进制在哪。
    info.machineID = parsed?.machineID || null;
    info.userID = parsed?.userID || null;
    info.installMethod = parsed?.installMethod || null;
    info.autoUpdates = typeof parsed?.autoUpdates === "boolean" ? parsed.autoUpdates : null;
    const mcp = parsed?.mcpServers;
    if (mcp && typeof mcp === "object") {
      info.mcpServerCount = Object.keys(mcp).length;
      info.mcpServerNames = Object.keys(mcp);
    }
    // 资料快照时间——整块面板读的是本地缓存文件不是实时接口，不说明数据有多旧是不诚实的。
    if (parsed?.oauthAccount?.profileFetchedAt) {
      info.profileFetchedAt = parsed.oauthAccount.profileFetchedAt;
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
  info.claudeCodeVersion = claudeCodeVersion();
  return info;
}

// Claude Code 的版本。`claude --version` 是唯一权威的答案，但每次请求都 spawn 一个进程
// 太浪费，所以进程内缓存住——版本在 Web UI 的一个生命周期里不会变，真变了也是因为
// Claude Code 升级，那时候本来就该重启这个服务。
//
// 两级兜底：拿不到命令（不在 PATH 里）就看 ~/.local/share/claude/versions 下版本号最大的
// 那个目录；再拿不到就退到 ~/.claude.json 的 lastClawdEntranceVersion。后两者都是近似值，
// 所以回传时带上 approx 标记，界面上如实标出来，不假装是准确值。
let versionCache = null;
function claudeCodeVersion() {
  if (versionCache) return versionCache;
  try {
    const out = execFileSync("claude", ["--version"], { timeout: 4000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const m = out.match(/\d+\.\d+\.\d+/);
    if (m) return (versionCache = { value: m[0], approx: false });
  } catch (e) {
    // 不在 PATH 里 / 超时 / 非零退出，继续往下兜
  }
  try {
    const dir = path.join(os.homedir(), ".local", "share", "claude", "versions");
    const cmp = (a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
      return 0;
    };
    const newest = fs
      .readdirSync(dir)
      .filter((d) => /^\d+\.\d+\.\d+$/.test(d))
      .sort(cmp)
      .pop();
    if (newest) return (versionCache = { value: newest, approx: true });
  } catch (e) {
    /* 目录不存在就继续兜 */
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, "utf8"));
    if (parsed?.lastClawdEntranceVersion) {
      return (versionCache = { value: parsed.lastClawdEntranceVersion, approx: true });
    }
  } catch (e) {
    /* 读不到就返回 null */
  }
  return null;
}

module.exports = { getAccountInfo };
