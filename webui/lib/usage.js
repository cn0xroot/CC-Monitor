"use strict";
// 账号级用量/额度信息——跟 ccstatusline (https://github.com/sirmalloc/ccstatusline) 读的是
// 同一份东西：Claude Code 自己写在本地的 OAuth 凭证文件，用它调 Anthropic 的用量查询接口。
// 不是我们自己的接口，是逆向 ccstatusline 实现确认过的：
//   凭证: ~/.claude/.credentials.json -> claudeAiOauth.accessToken
//   接口: GET https://api.anthropic.com/api/oauth/usage  (Bearer token)
// 只读查询，用的是 Claude Code 本来就持有、本来就信任的凭证，不做任何写操作。
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { HttpsProxyAgent } = require("https-proxy-agent");

const CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const USAGE_API_HOST = "api.anthropic.com";
const USAGE_API_PATH = "/api/oauth/usage";
const CACHE_MAX_AGE_MS = 180 * 1000; // 跟 ccstatusline 一样，避免把接口打太狠

function proxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyUrl) return undefined;
  try {
    return new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    return undefined;
  }
}

let cached = null; // { fetchedAt, data } | { fetchedAt, error }

function readAccessToken() {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken || null;
  } catch (e) {
    return null;
  }
}

function bucketInfo(bucket) {
  if (!bucket) return null;
  return {
    utilization: typeof bucket.utilization === "number" ? bucket.utilization : null,
    resetsAt: bucket.resets_at || null,
  };
}

function fetchUsageOnce(token) {
  return new Promise((resolve) => {
    const agent = proxyAgent();
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
            resolve({
              data: {
                session: bucketInfo(parsed.five_hour),
                weekly: bucketInfo(parsed.seven_day),
                weeklySonnet: bucketInfo(parsed.seven_day_sonnet),
                weeklyOpus: bucketInfo(parsed.seven_day_opus),
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

  const token = readAccessToken();
  if (!token) {
    cached = { fetchedAt: now, error: "没找到 Claude Code 的登录凭证 (~/.claude/.credentials.json)，无法查询额度" };
    return cached;
  }
  const result = await fetchUsageOnce(token);
  cached = { fetchedAt: now, ...result };
  return cached;
}

module.exports = { getUsage };
