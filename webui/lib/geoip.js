"use strict";
// IP 归属地查询——本地 MaxMind GeoLite2 数据库，不是每个 IP 都发请求去问第三方 API
// （那样等于把 Claude Code 访问过哪些网站/服务器泄露给了另一个第三方）。数据库文件
// 得用户自己去 MaxMind 官网注册免费账号、拿 license key 下载，这里不代劳、也不内置
// （license 条款不允许直接分发数据库文件）。
//
// 没配置数据库的时候这个模块整体优雅降级：查询返回 null，前端如实显示"没有地理位置
// 数据"，不编造/不估算假坐标——参考 BeeEye 的 GeoAccuracyBadge 那个"诚实标注精度"
// 的思路（下载: https://github.com/cn0xroot/BeeEye/blob/main/BeeEye-web/src/components/GeoAccuracyBadge.jsx）。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { countryNameZh } = require("./countryNamesZh");

const CANDIDATE_PATHS = [
  process.env.CC_MONITOR_GEOIP_DB,
  path.join(os.homedir(), ".cc-monitor", "GeoLite2-City.mmdb"),
  path.join(os.homedir(), ".cc-monitor", "GeoLite2-Country.mmdb"),
  // dbip-city.mmdb：DB-IP Lite（CC BY 4.0，不用注册 MaxMind 账号），见
  // https://github.com/sapics/ip-location-db —— 字段是平铺格式，下面 lookup()
  // 里已经兼容处理了，不需要额外配置就能直接用。
  path.join(os.homedir(), ".cc-monitor", "dbip-city.mmdb"),
].filter(Boolean);

let reader = null; // maxmind.Reader 实例，懒加载一次
let dbPath = null;
let dbKind = null; // "city" | "country" | null
let loadPromise = null; // 正在进行/已完成的加载 Promise，不是一个简单的布尔标志位

function resolveDbPath() {
  for (const p of CANDIDATE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 用一个共享的 in-flight Promise 而不是"是否已经试过"这种布尔标志位——
// getStatus() 和 lookup() 经常会在同一次 HTTP 请求里被 Promise.all 并发调用，
// 如果只用布尔值判断"还没试过就去 await"，第二个并发调用会看到"已经在试了"就
// 直接跳过、拿到还没赋值完的 reader（还是 null），明明数据库加载其实成功了，
// getStatus() 却报"不可用"。所有调用者都 await 同一个 Promise 就不会有这个问题。
function ensureLoaded() {
  if (!loadPromise) loadPromise = _load();
  return loadPromise;
}

async function _load() {
  const found = resolveDbPath();
  if (!found) return;
  try {
    const maxmind = require("maxmind");
    reader = await maxmind.open(found);
    dbPath = found;
    dbKind = found.toLowerCase().includes("country") ? "country" : "city";
  } catch (e) {
    reader = null;
    dbPath = null;
    dbKind = null;
  }
}

async function getStatus() {
  await ensureLoaded();
  return {
    available: !!reader,
    accuracy: dbKind, // "city" | "country" | null（前端拿这个字段判断标什么徽章）
    dbPath: dbPath || null,
    candidatePaths: CANDIDATE_PATHS,
  };
}

// MaxMind GeoLite2 的 city.names/country.names 是个多语言对象（en/zh-CN/ja/de/fr/es/
// pt-BR/ru），之前一直写死取 .en，导致中文界面下城市/国家名也是英文
// （比如 "Tseung Kwan O, HK"）。DB-IP Lite 那种平铺格式（sapics/ip-location-db 转出来
// 的）本身就没有多语言字段，取不到 zh-CN 的话自然回退回英文，这是数据源的限制，不是
// bug。UI 语言（"zh"/"en"）跟 mmdb 里的 locale key 不是一一对应，"zh" 要映射成
// "zh-CN"，其它语言暂时都还是回退到 en。
const UI_LANG_TO_MMDB_LOCALE = { zh: "zh-CN", en: "en" };
function localizedName(names, lang) {
  if (!names) return null;
  const locale = UI_LANG_TO_MMDB_LOCALE[lang] || "en";
  return names[locale] || names.en || null;
}

const lookupCache = new Map(); // (ip, lang) -> 结果（或 null），进程生命周期内有效，IP 地理位置不会变

async function lookup(ip, lang = "en") {
  if (!ip) return null;
  const cacheKey = ip + "|" + lang;
  if (lookupCache.has(cacheKey)) return lookupCache.get(cacheKey);
  await ensureLoaded();
  if (!reader) {
    lookupCache.set(cacheKey, null);
    return null;
  }
  let result = null;
  try {
    const rec = reader.get(ip);
    if (rec) {
      // 两种常见 mmdb 字段布局都要认：MaxMind 官方数据库是嵌套的
      // （city.names.en / location.latitude），像 DB-IP Lite（sapics/ip-location-db
      // 转出来的那份）这种非 MaxMind 数据源导出的 mmdb 则是平铺字段
      // （city / country_code / latitude），只按 MaxMind 的嵌套路径取的话，
      // 平铺格式的数据库会查出一堆 null，明明数据库里其实有数据。
      const lat = rec.location?.latitude ?? rec.latitude;
      const lon = rec.location?.longitude ?? rec.longitude;
      const countryCode = rec.country?.iso_code || rec.country_code || null;
      result = {
        // dbip-city.mmdb（DB-IP Lite）这种扁平格式数据源没有 names 多语言字段、
        // 甚至没有英文国家全名，只有 country_code 这个 ISO 代码——localizedName()
        // 在这种数据源上永远拿不到东西，最后兜底查静态的 ISO 代码->中文名表
        // （只覆盖国家/地区这一级，城市名没有对应的中文数据源，翻不出来）。
        country:
          localizedName(rec.country?.names, lang) ||
          localizedName(rec.registered_country?.names, lang) ||
          rec.country_name ||
          (lang === "zh" ? countryNameZh(countryCode) : null) ||
          null,
        countryCode,
        city:
          localizedName(rec.city?.names, lang) ||
          (typeof rec.city === "string" ? rec.city : null) ||
          null,
        lat: typeof lat === "number" ? lat : null,
        lon: typeof lon === "number" ? lon : null,
        accuracyRadiusKm: rec.location?.accuracy_radius ?? null,
      };
    }
  } catch (e) {
    result = null;
  }
  lookupCache.set(cacheKey, result);
  return result;
}

module.exports = { getStatus, lookup };
