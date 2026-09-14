"use strict";
// 正向 DNS 解析，带内存缓存——命令文本里只有主机名（比如 git clone 的
// github.com），要在世界地图上标出来得先解析成 IP 再查 GeoIP。这是"查询时才做"的
// 惰性解析，不在 hook 里做（hook 要保持又快又不依赖网络，详见 audit.js 里
// commandNetworkHosts() 的注释）；每个主机名只解析一次，缓存到进程生命周期结束，
// 避免同一个域名在每次刷新页面时都重新发起 DNS 查询。
// 失败（域名已经不存在/网络问题/超时）缓存 null，同样不重试到下次进程重启——跟
// geoip.js 对"查不到"的处理方式一致：如实返回空，不重试到把请求拖慢。
const dns = require("dns");

const cache = new Map(); // host -> Promise<string|null>
const LOOKUP_TIMEOUT_MS = 3000;

function lookupWithTimeout(host) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, LOOKUP_TIMEOUT_MS);
    dns.lookup(host, { family: 4 }, (err, address) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(err ? null : address);
    });
  });
}

function resolveHost(host) {
  if (!cache.has(host)) {
    cache.set(host, lookupWithTimeout(host));
  }
  return cache.get(host);
}

module.exports = { resolveHost };
