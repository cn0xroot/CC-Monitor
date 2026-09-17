"use strict";
// 账号级用量/额度信息——跟 ccstatusline (https://github.com/sirmalloc/ccstatusline) 读的是
// 同一份东西：Claude Code 自己写在本地的 OAuth 凭证文件，用它调 Anthropic 的用量查询接口。
// 不是我们自己的接口，是逆向 ccstatusline 实现确认过的：
//   凭证: claudeAiOauth.accessToken（Linux 在 ~/.claude/.credentials.json，macOS 在钥匙串，
//         见 lib/credentials.js）
//   接口: GET https://api.anthropic.com/api/oauth/usage  (Bearer token)
// 只读查询，用的是 Claude Code 本来就持有、本来就信任的凭证，不做任何写操作。
const https = require("https");
const { readClaudeOauth, credentialsLocationHint, isExpired } = require("./credentials");
// https-proxy-agent 装的是纯 ESM 包（package.json 里 "type":"module"，没有 require 导出条件），
// 普通 node（本环境是 v22，支持同步 require(esm)）能 require 但 Electron 自带的旧版 Node 不行，
// 会直接抛 ERR_REQUIRE_ESM 把桌面版启动流程崩掉——改成动态 import() 两边都兼容。

const USAGE_API_HOST = "api.anthropic.com";
const USAGE_API_PATH = "/api/oauth/usage";
const CACHE_MAX_AGE_MS = 180 * 1000; // 跟 ccstatusline 一样，避免把接口打太狠

async function proxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyUrl) return undefined;
  try {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    return new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    return undefined;
  }
}

let cached = null; // { fetchedAt, data } | { fetchedAt, error }

// 返回 { token } 或 { error }：凭证没有 / 已过期分开提示，别都糊成 "usage API 返回 401"。
function readAccessToken() {
  const oauth = readClaudeOauth();
  if (!oauth?.accessToken) {
    return { error: `没找到 Claude Code 的登录凭证 (${credentialsLocationHint()})，无法查询额度` };
  }
  if (isExpired(oauth)) {
    return { error: "Claude Code 登录凭证已过期，在 Claude Code 里跑一次任意命令让它自动刷新，或执行 /login 重新登录" };
  }
  return { token: oauth.accessToken };
}

function bucketInfo(bucket) {
  if (!bucket) return null;
  return {
    utilization: typeof bucket.utilization === "number" ? bucket.utilization : null,
    resetsAt: bucket.resets_at || null,
  };
}

// `limits` 数组是接口里比 five_hour/seven_day 更细一档的额度明细——同一个 kind
// （session/weekly_all/weekly_scoped）在不同 severity（normal/警告级别）下都会单独
// 列一条，weekly_scoped 那种还带具体是限定给哪个模型（scope.model）的。
function limitInfo(l) {
  return {
    kind: l.kind || null,
    group: l.group || null,
    percent: typeof l.percent === "number" ? l.percent : null,
    severity: l.severity || null,
    resetsAt: l.resets_at || null,
    scopeModel: l?.scope?.model?.display_name || null,
    isActive: !!l.is_active,
  };
}

// `spend`：账号超出套餐额度之后能不能/有没有额外花钱买用量（Anthropic 的"usage credits"），
// 跟 five_hour/seven_day 那种"百分比额度"是两码事，这里是实打实的金额。
function spendInfo(spend) {
  if (!spend) return null;
  return {
    usedAmountMinor: spend.used?.amount_minor ?? null,
    currency: spend.used?.currency || null,
    exponent: typeof spend.used?.exponent === "number" ? spend.used.exponent : 2,
    percent: typeof spend.percent === "number" ? spend.percent : null,
    severity: spend.severity || null,
    enabled: !!spend.enabled,
    disabledReason: spend.disabled_reason || null,
    canPurchaseCredits: !!spend.can_purchase_credits,
  };
}

async function fetchUsageOnce(token) {
  const agent = await proxyAgent();
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: USAGE_API_HOST,
        path: USAGE_API_PATH,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        timeout: 5000,
        ...(agent ? { agent } : {}),
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve({ error: `usage API 返回 ${res.statusCode}` });
            return;
          }
          try {
            const parsed = JSON.parse(body);
            const rawLimits = Array.isArray(parsed.limits) ? parsed.limits : [];
            // 有些模型（目前观察到的是 Fable）没有专门的顶层字段（不像 opus/sonnet 那样
            // 有 seven_day_opus/seven_day_sonnet），额度只挂在 limits[] 里一条
            // kind="weekly_scoped" 记录上，scope.model.display_name 就是模型名——
            // 不写死"Fable"，这样以后 Anthropic 加别的按模型限额也自动跟着显示。
            const perModelWeekly = rawLimits
              .filter((l) => l.kind === "weekly_scoped" && l?.scope?.model?.display_name)
              .map((l) => ({
                model: l.scope.model.display_name,
                utilization: typeof l.percent === "number" ? l.percent : null,
                resetsAt: l.resets_at || null,
              }));
            resolve({
              data: {
                session: bucketInfo(parsed.five_hour),
                weekly: bucketInfo(parsed.seven_day),
                weeklySonnet: bucketInfo(parsed.seven_day_sonnet),
                weeklyOpus: bucketInfo(parsed.seven_day_opus),
                perModelWeekly,
                limits: rawLimits.map(limitInfo),
                spend: spendInfo(parsed.spend),
              },
            });
          } catch (e) {
            resolve({ error: "usage API 返回内容解析失败" });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "usage API 请求超时" });
    });
    req.on("error", (e) => resolve({ error: e.message }));
    req.end();
  });
}

async function getUsage() {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_MAX_AGE_MS) return cached;

  const { token, error } = readAccessToken();
  if (!token) {
    cached = { fetchedAt: now, error };
    return cached;
  }
  const result = await fetchUsageOnce(token);
  cached = { fetchedAt: now, ...result };
  return cached;
}

module.exports = { getUsage };
