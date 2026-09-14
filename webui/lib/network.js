"use strict";
// Claude Code 网络流量——主数据来自系统层探针（cc_monitor/probe_linux.bt，Linux +
// eBPF；macOS 是 probe_darwin.py + nettop）写进 events.db 的 network_traffic 表：按
// (ip, port) 聚合的连接次数/上传下载字节数。探针没装、没在跑的时候这张表是空的。
//
// 补充数据来自 Claude 通过 Bash 执行的、命令文本上看起来会联网的操作（wget/curl/
// git clone/ssh/scp/…，见 audit.js 的 commandNetworkHosts()）——很多人从来没手动
// 启动过系统层探针，之前这种情况下"AI 轨迹"/世界地图完全是空的，即使 Claude 明明
// 执行过一堆联网命令。这类数据只是"命令文本上看起来要连这个 host"，不代表真的连
// 通了（可能失败/超时/被 policy 拦截），也没有字节数——跟探针实测数据是两种不同
// 性质的证据，下面统一加了 inferred:true 标记，前端会展示区分，不会冒充成真实
// 流量。
const Database = require("better-sqlite3");
const audit = require("./audit");
const { dbPath } = audit;
const dnscache = require("./dnscache");
const geoip = require("./geoip");

function withDb(fn, fallback) {
  let db;
  try {
    db = new Database(dbPath(), { readonly: true, fileMustExist: true });
    return fn(db);
  } catch (e) {
    return fallback;
  } finally {
    if (db) db.close();
  }
}

function rawRows(limit) {
  return withDb((db) => {
    return db
      .prepare(
        `SELECT ip, port, host, tx_bytes, rx_bytes, connect_count, first_seen, last_seen
         FROM network_traffic
         ORDER BY (tx_bytes + rx_bytes) DESC
         LIMIT ?`
      )
      .all(limit);
  }, []);
}

// 探针在同一个长连接上可能因为路由/多网卡之类原因拿到 port=0 且没传字节的记录
// （见 probe.py 里的说明），这种行除了"确实连过一次"以外没有别的信息量，列表里
// 全是这种噪音的话反而看不清真正的流量在哪，默认过滤掉。
function isNoiseRow(r) {
  return r.port === 0 && r.tx_bytes === 0 && r.rx_bytes === 0;
}

// 把 commandNetworkHosts() 拿到的"命令里出现过的 host"按 host 分组去重、解析成 IP，
// 拼成跟 rawRows() 同一种形状的行，好复用下面这几个函数里已经有的 geoip 查询/排序/
// 过滤逻辑，不用另外写一套。解析不出 IP 的 host（域名失效/网络问题/超时）直接跳过，
// 不硬凑一个假地址；探针已经实测到同一个 IP 的，不再重复生成一条推断行——那个 IP
// 已经有更可信的真实流量数据了。
async function inferredRows(existingIps) {
  const entries = audit.commandNetworkHosts();
  const byHost = new Map();
  for (const e of entries) {
    let g = byHost.get(e.host);
    if (!g) {
      g = { host: e.host, connectCount: 0, firstSeen: e.ts, lastSeen: e.ts };
      byHost.set(e.host, g);
    }
    g.connectCount += 1;
    if (e.ts < g.firstSeen) g.firstSeen = e.ts;
    if (e.ts > g.lastSeen) g.lastSeen = e.ts;
  }
  const rows = [];
  for (const g of byHost.values()) {
    const ip = await dnscache.resolveHost(g.host);
    if (!ip || existingIps.has(ip)) continue;
    rows.push({
      ip,
      port: 0,
      host: g.host,
      tx_bytes: 0,
      rx_bytes: 0,
      connect_count: g.connectCount,
      first_seen: g.firstSeen,
      last_seen: g.lastSeen,
      inferred: true,
    });
  }
  return rows;
}

async function mergedRows(limit) {
  const real = rawRows(Math.max(limit * 2, limit, 100000)).filter((r) => !isNoiseRow(r));
  const existingIps = new Set(real.map((r) => r.ip));
  const inferred = await inferredRows(existingIps);
  return real.concat(inferred);
}

async function listTraffic(limit = 200) {
  const rows = (await mergedRows(limit)).slice(0, limit);
  const enriched = [];
  for (const r of rows) {
    const geo = await geoip.lookup(r.ip);
    enriched.push({
      ip: r.ip,
      port: r.port,
      host: r.host,
      txBytes: r.tx_bytes,
      rxBytes: r.rx_bytes,
      connectCount: r.connect_count,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      inferred: !!r.inferred,
      geo,
    });
  }
  return enriched;
}

async function summary() {
  const rows = await mergedRows(100000);
  let txBytes = 0;
  let rxBytes = 0;
  let connectCount = 0;
  const ips = new Set();
  for (const r of rows) {
    txBytes += r.tx_bytes;
    rxBytes += r.rx_bytes;
    connectCount += r.connect_count;
    ips.add(r.ip);
  }
  return { txBytes, rxBytes, connectCount, distinctIps: ips.size };
}

// 世界地图用的数据形状——只要有经纬度的行才有意义画到地图上，拿不到地理位置的
// （没配置 GeoIP 数据库，或者这个 IP 查不到）不会出现在这个列表里，但仍然会出现在
// listTraffic() 的表格里（如实标"未知位置"，不是被吞掉了）。
async function geoPairs(limit = 500) {
  const rows = await mergedRows(limit);
  const pairs = [];
  for (const r of rows) {
    const geo = await geoip.lookup(r.ip);
    if (!geo || geo.lat === null || geo.lon === null) continue;
    pairs.push({
      ip: r.ip,
      host: r.host,
      lat: geo.lat,
      lon: geo.lon,
      country: geo.country,
      city: geo.city,
      bytes: r.tx_bytes + r.rx_bytes,
      // 世界地图的"连线光点来回"动画要按方向画（上传为主 vs 下载为主，箭头朝向不一样）：
      // 单独把 tx/rx 拆出来，而不是只给合计的 bytes。
      txBytes: r.tx_bytes,
      rxBytes: r.rx_bytes,
      lastSeen: r.last_seen,
      inferred: !!r.inferred,
    });
    if (pairs.length >= limit) break;
  }
  return pairs;
}

module.exports = { listTraffic, summary, geoPairs };
