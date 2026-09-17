"use strict";
// lsof -Fpn 输出的解析（macOS 上进程 cwd 的唯一来源）。cwd 全是 null 会让 /api/status
// 把每个会话都判成 dead，生命体征指示器一律画成灰色直线——这个测试守的就是那条链路的头。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseLsofCwds } = require("../lib/processScan");

test("按 p/f/n 三行一组解析出 pid → cwd", () => {
  const out = parseLsofCwds("p32151\nfcwd\nn/Users/me/work\np47737\nfcwd\nn/Users/me\n");
  assert.equal(out.get(32151), "/Users/me/work");
  assert.equal(out.get(47737), "/Users/me");
  assert.equal(out.size, 2);
});

test("只有 p 行没有 n 行的 pid（权限不够/进程已退出）不产生条目", () => {
  const out = parseLsofCwds("p111\np222\nfcwd\nn/tmp\n");
  assert.equal(out.has(111), false);
  assert.equal(out.get(222), "/tmp");
});

test("路径里有空格也完整保留", () => {
  const out = parseLsofCwds("p9\nfcwd\nn/Users/me/My Projects/app\n");
  assert.equal(out.get(9), "/Users/me/My Projects/app");
});

test("空输出/undefined 返回空 Map，不抛异常", () => {
  assert.equal(parseLsofCwds("").size, 0);
  assert.equal(parseLsofCwds(undefined).size, 0);
});
