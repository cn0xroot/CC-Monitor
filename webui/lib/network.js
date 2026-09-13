"use strict";
// Claude Code 网络流量——数据来自系统层探针（cc_monitor/probe_linux.bt，Linux + eBPF
// 才有）写进同一个 events.db 的 network_traffic 表：按 (ip, port) 聚合的连接次数/
// 上传下载字节数。没装探针、探针没在跑的时候这张表就是空的，接口如实返回空列表，
// 不是 bug。
const Database = require("better-sqlite3");
const { dbPath } = require("./audit");
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

async function listTraffic(limit = 200) {
  const rows = rawRows(Math.max(limit * 2, limit)).filter((r) => !isNoiseRow(r)).slice(0, limit);
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
      geo,
    });
  }
  return enriched;
}

async function summary() {
  const rows = rawRows(100000).filter((r) => !isNoiseRow(r));
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
  const rows = rawRows(Math.max(limit * 2, limit)).filter((r) => !isNoiseRow(r));
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
      lastSeen: r.last_seen,
    });
    if (pairs.length >= limit) break;
  }
  return pairs;
}

module.exports = { listTraffic, summary, geoPairs };
