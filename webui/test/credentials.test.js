"use strict";
// lib/credentials.js 的挑选逻辑：多份凭证里优先未过期的，全过期挑最晚的（复现"钥匙串里
// 残留一条 acct=root 的过期记录 → usage API 一直 401"那个 bug）。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pickOauth, isExpired } = require("../lib/credentials");

const NOW = 1_000_000;
const raw = (token, expiresAt) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } });

test("优先返回未过期的凭证，即使过期的排在前面", () => {
  const picked = pickOauth([raw("stale-root", NOW - 1), raw("fresh", NOW + 3600_000)], NOW);
  assert.equal(picked.accessToken, "fresh");
});

test("多份都未过期时按来源顺序取第一份", () => {
  const picked = pickOauth([raw("a", NOW + 10), raw("b", NOW + 20)], NOW);
  assert.equal(picked.accessToken, "a");
});

test("全部过期时返回过期最晚的那份，调用方能看出它过期", () => {
  const picked = pickOauth([raw("older", NOW - 500), raw("newer", NOW - 10)], NOW);
  assert.equal(picked.accessToken, "newer");
  assert.equal(isExpired(picked, NOW), true);
});

test("跳过 null / 非 JSON / 缺 claudeAiOauth 的来源", () => {
  const picked = pickOauth([null, "not json", JSON.stringify({ foo: 1 }), raw("ok", NOW + 1)], NOW);
  assert.equal(picked.accessToken, "ok");
  assert.equal(pickOauth([null, "{}"], NOW), null);
});

test("没有 expiresAt 的旧格式当作未过期", () => {
  const legacy = JSON.stringify({ claudeAiOauth: { accessToken: "legacy" } });
  assert.equal(isExpired(JSON.parse(legacy).claudeAiOauth, NOW), false);
  assert.equal(pickOauth([raw("stale", NOW - 1), legacy], NOW).accessToken, "legacy");
});
