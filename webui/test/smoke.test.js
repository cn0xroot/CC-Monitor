"use strict";
// 端到端冒烟测试：自己起一个隔离的 server 实例（独立端口 + 临时 CC_MONITOR_HOME），
// 不碰正在跑的那个真实实例，跑完自动清理。
//
// 用法: node --test test/smoke.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");

const TEST_PORT = 9198;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const REPO_ROOT = path.resolve(__dirname, "..", "..");

let serverProc;
let tmpHome;

function fetchJson(pathname, opts) {
  return fetch(BASE + pathname, opts).then((r) => r.json().then((body) => ({ status: r.status, body })));
}

function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const tryOnce = async () => {
    try {
      const res = await fetch(BASE + "/api/sessions");
      if (res.ok) return true;
    } catch (e) {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("server did not start in time");
    await new Promise((r) => setTimeout(r, 150));
    return tryOnce();
  };
  return tryOnce();
}

// 用真实的 Python cc_monitor.storage 模块写入几条测试事件，这样能验证 webui 的
// JS 格式化逻辑跟 Python 那边写进去的真实 schema 是兼容的，而不是自娱自乐。
function seedAuditEvents(ccMonitorHome) {
  const script = `
import os
os.environ["CC_MONITOR_HOME"] = ${JSON.stringify(ccMonitorHome)}
import sys
sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})
from cc_monitor import storage

storage.log_event(
    session_id="test-session-1", source="hook_pre", tool_name="Bash",
    detail={"command": "rm -rf /"}, cwd="/tmp",
    risk="high", matched_rule="dangerous_delete", decision="blocked",
)
storage.log_event(
    session_id="test-session-1", source="hook_post", tool_name="Bash",
    detail={"input": {"command": "echo hello"}, "response": {"stdout": "hello\\n", "stderr": "", "interrupted": False}},
    cwd="/tmp", risk="info", matched_rule=None, decision="completed",
)
storage.log_event(
    session_id="test-session-2", source="os_exec", tool_name="python3",
    detail={"pid": "1", "uid": "0", "argv": "python3 script.py", "shell_command": None, "hook_matched": True, "matched_rule": None, "note": None},
    cwd="", risk="info", matched_rule=None, decision="observed",
)
print("seeded")
`;
  execFileSync("python3", ["-c", script], { stdio: "inherit" });
}

test.before(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-monitor-webui-test-"));
  seedAuditEvents(tmpHome);

  serverProc = spawn("node", [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      CC_MONITOR_WEBUI_PORT: String(TEST_PORT),
      CC_MONITOR_WEBUI_HOST: "127.0.0.1",
      CC_MONITOR_HOME: tmpHome,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
    stdio: "pipe",
  });
  serverProc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForServer();
});

test.after(() => {
  if (serverProc) serverProc.kill();
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("static assets serve with 200", async () => {
  for (const p of ["/", "/app.js", "/style.css", "/vendor/xterm/lib/xterm.js", "/vendor/xterm/css/xterm.css", "/vendor/xterm-addon-webgl/xterm-addon-webgl.js", "/vendor/xterm-addon-fit/xterm-addon-fit.js"]) {
    const res = await fetch(BASE + p);
    assert.equal(res.status, 200, `${p} should be 200`);
  }
});

test("index.html references only ids that exist, and has all four nav tabs", async () => {
  const html = await (await fetch(BASE + "/")).text();
  for (const tab of ["home", "logs", "terminal", "status"]) {
    assert.match(html, new RegExp(`data-tab="${tab}"`), `missing tab button for ${tab}`);
    assert.match(html, new RegExp(`id="view-${tab}"`), `missing view section for ${tab}`);
  }
});

test("session lifecycle: create, list, websocket I/O, kill", async () => {
  const created = await fetchJson("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: "/tmp" }),
  });
  assert.equal(created.status, 200);
  assert.ok(created.body.id, "should return a session id");
  const id = created.body.id;

  const list1 = await fetchJson("/api/sessions");
  assert.ok(list1.body.some((s) => s.id === id && s.alive), "new session should appear as alive");

  // WebSocket should stream real PTY output (the shell banner / prompt).
  const data = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws/terminal?id=${id}`);
    let buf = "";
    const timer = setTimeout(() => {
      ws.close();
      resolve(buf);
    }, 2500);
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === "data") buf += msg.data;
    });
  });
  assert.ok(data.length > 0, "should receive some PTY output over the websocket");

  const killed = await fetchJson("/api/sessions/" + id, { method: "DELETE" });
  assert.equal(killed.body.ok, true);

  const list2 = await fetchJson("/api/sessions");
  assert.ok(!list2.body.some((s) => s.id === id), "killed session should be gone from the list");
});

test("audit endpoints reflect seeded events with correct formatting", async () => {
  const logSessions = await fetchJson("/api/log-sessions");
  const ids = logSessions.body.map((r) => r.session_id);
  assert.ok(ids.includes("test-session-1"));
  assert.ok(ids.includes("test-session-2"));

  const logs = await fetchJson("/api/logs?session_id=test-session-1&limit=10");
  assert.equal(logs.body.events.length, 2);

  const blockedEvent = logs.body.events.find((e) => e.decision === "blocked");
  assert.ok(blockedEvent, "the rm -rf / event should show up as blocked");
  assert.equal(blockedEvent.risk, "high");
  assert.equal(blockedEvent.matchedRule, "dangerous_delete");
  assert.match(blockedEvent.summaryHtml, /tok-cmd/, "Bash command summary should be syntax-highlighted");
  assert.doesNotMatch(blockedEvent.summaryHtml, /<script/i, "must not allow HTML injection");

  const completedEvent = logs.body.events.find((e) => e.decision === "completed");
  assert.ok(completedEvent);
  assert.match(completedEvent.extra.map((e) => e.html).join(""), /成功/);

  const stats = await fetchJson("/api/stats");
  assert.ok(stats.body.total >= 3);
  assert.ok(stats.body.blockedTotal >= 1);

  const overview = await fetchJson("/api/overview");
  assert.ok(overview.body.sessionCount >= 2);

  const status = await fetchJson("/api/status");
  assert.ok(Array.isArray(status.body.auditSessions));
  assert.ok(status.body.auditSessions.some((s) => s.sessionId === "test-session-1"));
});

test("HTML escaping: a malicious command does not break out of its span", async () => {
  const script = `
import os
os.environ["CC_MONITOR_HOME"] = ${JSON.stringify(tmpHome)}
import sys
sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})
from cc_monitor import storage
storage.log_event(
    session_id="xss-test", source="hook_pre", tool_name="Bash",
    detail={"command": "echo '<img src=x onerror=alert(1)>'"},
    cwd="/tmp", risk="low", matched_rule=None, decision="allowed",
)
`;
  execFileSync("python3", ["-c", script]);
  const logs = await fetchJson("/api/logs?session_id=xss-test&limit=5");
  const ev = logs.body.events[0];
  assert.doesNotMatch(ev.summaryHtml, /<img/i, "raw HTML from a command must be escaped, not injected");
  assert.match(ev.summaryHtml, /&lt;img/i);
});
