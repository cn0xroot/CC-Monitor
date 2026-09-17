"use strict";
// 介入级别分段控件的回归测试。
//
// 锁住三条性质：
// 1. 三档各有自己的一段，任意两档之间都是一步可达——旧版是"切换按钮 + 单独的停止按钮"，
//    从"已关闭"出发时切换按钮指向"拦截中"，导致关闭态没法一步切到观察模式；
// 2. 当前档由 aria-checked 表达，样式和读屏器用同一个事实来源；
// 3. 每一档都有对应的说明文案，中英两份都在。
//
// 用法: node --test test/audit-level.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PUB = path.resolve(__dirname, "..", "public");
const html = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(PUB, "app.js"), "utf8");
const i18n = fs.readFileSync(path.join(PUB, "i18n.js"), "utf8");
const css = fs.readFileSync(path.join(PUB, "style.css"), "utf8");

const LEVELS = ["running", "paused", "stopped"];

test("三档各有一段，data-level 覆盖全部档位", () => {
  const found = [...html.matchAll(/class="seg-opt lv-\w+" data-level="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(found.sort(), [...LEVELS].sort(), "三个档位必须各有且只有一段");
});

test("每一段都是 radio，且归属同一个 radiogroup", () => {
  assert.match(html, /id="audit-level-seg"[^>]*role="radiogroup"/);
  const radios = html.match(/class="seg-opt[^"]*"[^>]*role="radio"/g) || [];
  assert.equal(radios.length, 3);
});

test("任意两档之间一步可达：不再有 nextState 这种间接跳转", () => {
  // 旧实现靠 dataset.nextState 决定"点一下去哪"，只能表达两档之间的来回切换，
  // 第三档必然有一条到不了的边。新实现是点哪段就去哪档，没有这个中间量。
  assert.ok(!appJs.includes("nextState"), "app.js 不应再出现 nextState 间接跳转");
  assert.match(appJs, /chooseAuditLevel\(\s*opt\.dataset\.level\s*\)/,
    "点击应直接把该段自己的档位传进去");
});

test("只有切到已关闭才二次确认，另外两档直接切", () => {
  const fn = appJs.slice(appJs.indexOf("async function chooseAuditLevel"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /level === "stopped"/, "已关闭必须走确认框");
  assert.match(body, /confirmDialog/);
  // 确认框只能包住 stopped 这一支，不能把三档都拦下来
  assert.equal((body.match(/confirmDialog/g) || []).length, 1);
});

test("点当前档是空操作，不重复发请求", () => {
  assert.match(appJs, /current\.dataset\.level === level\) return/);
});

test("当前档用 aria-checked 表达，CSS 也挂在同一个属性上", () => {
  assert.match(appJs, /setAttribute\("aria-checked"/);
  for (const lv of LEVELS) {
    assert.ok(
      css.includes(`.lv-${lv}[aria-checked="true"]`),
      `${lv} 的选中态样式必须由 aria-checked 驱动，不能另起一套 class`
    );
  }
});

test("三档各有自己的身份色，且不复用好/坏语义色", () => {
  // 拦截=紫、观察=绿、关闭=黄。刻意不走 --green/--yellow/--red，那套是随主题变的
  // 好坏语义色，而档位要的是三个互相区分得开、跨主题一致的身份色。
  for (const v of ["--lv-enforce", "--lv-observe", "--lv-off"]) {
    assert.ok(css.includes(`${v}:`), `缺少档位色变量 ${v}`);
    assert.ok(css.includes(`${v}-on:`), `缺少 ${v} 的配套前景色`);
  }
  const map = { running: "--lv-enforce", paused: "--lv-observe", stopped: "--lv-off" };
  for (const [lv, v] of Object.entries(map)) {
    const rule = css.match(new RegExp(`\\.lv-${lv}\\[aria-checked="true"\\][^}]*}`));
    assert.ok(rule, `${lv} 缺少选中态规则`);
    assert.ok(rule[0].includes(`var(${v})`), `${lv} 应当用 ${v}`);
    assert.ok(rule[0].includes(`var(${v}-on)`), `${lv} 的文字应当用配套前景色，保证对比度`);
  }
});

test("顶栏药丸和首页圆点跟分段控件用同一套档位色", () => {
  const map = { running: "--lv-enforce", paused: "--lv-observe", stopped: "--lv-off" };
  // 一个档位可能出现在多条规则里（比如三档共用的 font-weight 分组选择器），
  // 所以收集全部匹配，只要有任意一条用了该档位的颜色变量就算过——只看第一条会
  // 被分组规则抢先截走。
  const rulesFor = (sel) => [...css.matchAll(new RegExp(`${sel}\\s*\\{[^}]*\\}`, "g"))].map((m) => m[0]);
  for (const [lv, v] of Object.entries(map)) {
    const pill = rulesFor(`\\.audit-state-${lv}`);
    assert.ok(pill.some((r) => r.includes(`var(${v})`)), `顶栏药丸 ${lv} 应当用 ${v}`);
    const dot = rulesFor(`\\.strip-dot\\.${lv}`);
    assert.ok(dot.some((r) => r.includes(`var(${v})`)), `首页圆点 ${lv} 应当用 ${v}`);
  }
});

test("选中态不只靠颜色：小圆点空心/实心也要区分", () => {
  assert.match(css, /\.seg-opt\[aria-checked="true"\] \.seg-dot \{ background: currentColor/);
});

test("每一档都有说明文案，中英两份都在", () => {
  for (const lv of LEVELS) {
    const key = `"home.auditCtl.levelNote.${lv}":`;
    const n = (i18n.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    assert.equal(n, 2, `${lv} 的说明文案中英各要有一条`);
  }
});

test("说明行元素存在，且渲染时会被填上", () => {
  assert.match(html, /id="audit-level-note"/);
  assert.match(appJs, /audit-level-note/);
  assert.match(appJs, /home\.auditCtl\.levelNote\." \+ state/);
});

// ---------- 账号打码范围 ----------
// "隐藏敏感信息"只该遮能指认到具体某个人的三项。曾经是九项全遮，遮完之后那块面板
// 就没有展示价值了，而组织角色/套餐/额度档位/计费方式/创建时间属于账号属性不是身份。
const ACCOUNT_JS = appJs.slice(
  appJs.indexOf("function renderAccountProfileInto"),
  appJs.indexOf("async function refreshAccountProfile")
);

test("姓名/邮箱/组织走打码，四个标识符走 ident（同样打码）", () => {
  for (const f of ["info.displayName", "info.email", "info.organizationName"]) {
    assert.ok(ACCOUNT_JS.includes(`mask(${f})`), `${f} 应当打码`);
  }
  // 标识符走 ident()：正常显示时截断成"头8…尾4"，打码时同样变成 ***
  for (const f of ["info.accountUuid", "info.organizationUuid", "info.userID", "info.machineID"]) {
    assert.ok(ACCOUNT_JS.includes(`ident(${f})`), `${f} 应当走 ident`);
  }
});

test("ident 打码时连 title 一起遮，不能悬停看到原值", () => {
  const fn = appJs.slice(appJs.indexOf("const ident = (text) =>"));
  const body = fn.slice(0, fn.indexOf("\n  };"));
  // 先判 accountMasked 并直接 return，title 分支根本走不到
  assert.match(body, /if \(accountMasked\) return ACCOUNT_MASK_TEXT;/);
  const maskedIdx = body.indexOf("accountMasked");
  const titleIdx = body.indexOf("title=");
  assert.ok(maskedIdx < titleIdx, "打码判断必须在拼 title 之前");
});

test("本机环境那几项一律明文，它们不是身份信息", () => {
  for (const f of ["info.installMethod"]) {
    assert.ok(ACCOUNT_JS.includes(`plain(${f})`), `${f} 不该被打码`);
  }
  // 版本 / 自动更新 / MCP 数量都不经过 mask 或 ident
  for (const f of ["claudeCodeVersion", "autoUpdates", "mcpServerCount"]) {
    assert.ok(!ACCOUNT_JS.includes(`mask(info.${f})`), `${f} 不该被打码`);
    assert.ok(!ACCOUNT_JS.includes(`ident(info.${f})`), `${f} 不该走 ident`);
  }
});

test("其余账号字段一律明文", () => {
  for (const f of [
    "info.organizationRole",
    "info.organizationType",
    "info.organizationRateLimitTier",
    "info.billingType",
  ]) {
    assert.ok(ACCOUNT_JS.includes(`plain(${f})`), `${f} 不该被打码`);
    assert.ok(!ACCOUNT_JS.includes(`mask(${f})`), `${f} 不该被打码`);
  }
  // 两个日期字段走的是格式化后的变量名
  assert.ok(ACCOUNT_JS.includes("plain(createdAt)"));
  assert.ok(ACCOUNT_JS.includes("plain(subCreatedAt)"));
});

test("打码用的仍是定长 ***，不泄露原值长度", () => {
  assert.match(appJs, /ACCOUNT_MASK_TEXT\s*=\s*"\*\*\*"/);
});
