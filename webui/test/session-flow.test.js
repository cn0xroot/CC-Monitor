"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSessionFlow, postStatus } = require("../lib/sessionFlow");

let nextId = 1;
const T0 = Date.parse("2026-09-27T05:00:00+09:00");
// 跟 Python time.strftime("%Y-%m-%dT%H:%M:%S%z") 同样的无冒号偏移格式
function ts(sec) {
  const d = new Date(T0 + sec * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const local = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}+0900`;
}
function ev(sec, source, tool, detail, extra = {}) {
  return { id: nextId++, ts: ts(sec), source, tool_name: tool, cwd: "/w", risk: "info", matched_rule: null, decision: source === "hook_post" ? "completed" : "allowed", detail: JSON.stringify(detail), ...extra };
}
const prompt = (sec, text) => ev(sec, "hook_prompt", "UserPromptSubmit", { prompt: text });
const stop = (sec) => ev(sec, "hook_lifecycle", "Stop", { stop_hook_active: false });
const pre = (sec, tool, input, extra) => ev(sec, "hook_pre", tool, input, extra);
const post = (sec, tool, input, response) => ev(sec, "hook_post", tool, { input, response });
const ops = (flow) => flow.turns.flatMap((t) => t.nodes);
const LONG_AGO = T0 + 24 * 3600 * 1000;

test("pairs pre/post into one node with duration and success", () => {
  const cmd = { command: "ls" };
  const flow = buildSessionFlow([prompt(0, "hi"), pre(1, "Bash", cmd), post(3, "Bash", cmd, { stdout: "a", stderr: "", interrupted: false }), stop(4)], { now: LONG_AGO });
  assert.equal(flow.turns.length, 1);
  const [n] = ops(flow);
  assert.equal(n.status, "ok");
  assert.equal(n.durationMs, 2000);
  assert.equal(n.eventIds.length, 2);
  assert.equal(flow.turns[0].prompt.text, "hi");
  assert.equal(flow.turns[0].stopped, true);
});

test("pre without post is a failure once the turn is over", () => {
  const flow = buildSessionFlow([prompt(0, "x"), pre(1, "Bash", { command: "false" }), stop(2)], { now: LONG_AGO });
  const [n] = ops(flow);
  assert.equal(n.status, "fail");
  assert.equal(n.reason, "noresult");
  assert.equal(flow.turns[0].stats.fail, 1);
});

test("pre without post in an unfinished, recently active turn is running", () => {
  const rows = [prompt(0, "x"), pre(1, "Bash", { command: "sleep 100" })];
  const flow = buildSessionFlow(rows, { now: T0 + 5000 });
  assert.equal(ops(flow)[0].status, "running");
  assert.equal(flow.live, true);
});

test("blocked pre is reported as blocked and does not steal a later retry's post", () => {
  const cmd = { command: "rm -rf /tmp/x" };
  const rows = [
    prompt(0, "x"),
    pre(1, "Bash", cmd, { decision: "blocked", risk: "high", matched_rule: "dangerous_delete" }),
    pre(2, "Bash", cmd),
    post(3, "Bash", cmd, { stdout: "", stderr: "", interrupted: false }),
    stop(4),
  ];
  const [a, b] = ops(buildSessionFlow(rows, { now: LONG_AGO }));
  assert.equal(a.status, "blocked");
  assert.equal(a.risk, "high");
  assert.equal(a.matchedRule, "dangerous_delete");
  assert.equal(b.status, "ok");
});

test("a failed attempt followed by an identical retry: the post belongs to the retry", () => {
  const cmd = { command: "make" };
  const rows = [prompt(0, "x"), pre(1, "Bash", cmd), pre(5, "Bash", cmd), post(6, "Bash", cmd, { stdout: "", stderr: "", interrupted: false }), stop(7)];
  const [first, retry] = ops(buildSessionFlow(rows, { now: LONG_AGO }));
  assert.equal(first.status, "fail");
  assert.equal(retry.status, "ok");
  assert.equal(retry.durationMs, 1000);
});

test("parallel calls of the same tool pair by input, not by order", () => {
  const a = { file_path: "/a" };
  const b = { file_path: "/b" };
  const rows = [prompt(0, "x"), pre(1, "Edit", a), pre(1, "Edit", b), post(2, "Edit", b, {}), post(4, "Edit", a, {}), stop(5)];
  const [na, nb] = ops(buildSessionFlow(rows, { now: LONG_AGO, group: false }));
  assert.equal(na.durationMs, 3000);
  assert.equal(nb.durationMs, 1000);
});

test("postStatus reads failure markers from tool responses", () => {
  assert.equal(postStatus("Bash", { interrupted: true }).status, "fail");
  assert.equal(postStatus("Bash", { timedOutAfterMs: 120000 }).reason, "timeout");
  assert.equal(postStatus("Bash", { stderr: "warning: x" }).status, "warn");
  assert.equal(postStatus("Bash", { backgroundTaskId: "b1" }).status, "background");
  assert.equal(postStatus("WebFetch", { code: 404, codeText: "Not Found" }).detail, "404 Not Found");
  assert.equal(postStatus("Skill", { success: false, message: "nope" }).status, "fail");
  assert.equal(postStatus("Read", { type: "text" }).status, "ok");
  assert.equal(postStatus("Agent", { isAsync: true }).status, "background");
});

test("runs of quiet successful same-tool ops are grouped; risky ones break the run", () => {
  const rows = [prompt(0, "x")];
  for (let i = 0; i < 4; i++) {
    const inp = { file_path: "/f" + i };
    rows.push(pre(i + 1, "Read", inp), post(i + 1, "Read", inp, {}));
  }
  const risky = { file_path: "/etc/shadow" };
  rows.push(pre(10, "Read", risky, { risk: "high", matched_rule: "sensitive_read" }), post(10, "Read", risky, {}), stop(11));
  const nodes = buildSessionFlow(rows, { now: LONG_AGO }).turns[0].nodes;
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].type, "group");
  assert.equal(nodes[0].count, 4);
  assert.equal(nodes[0].items.length, 4);
  assert.equal(nodes[1].type, "op");
  assert.equal(nodes[1].risk, "high");
});

test("Agent calls are marked as branches; events before the first prompt form their own turn", () => {
  const agentIn = { description: "survey", prompt: "go", subagent_type: "Explore" };
  const rows = [
    ev(0, "hook_lifecycle", "SessionStart", { source: "startup" }),
    prompt(1, "x"),
    pre(2, "Agent", agentIn),
    post(3, "Agent", agentIn, { isAsync: true, status: "async_launched" }),
    ev(4, "hook_lifecycle", "SubagentStop", {}),
    stop(5),
  ];
  const flow = buildSessionFlow(rows, { now: LONG_AGO });
  assert.equal(flow.turns.length, 2);
  assert.equal(flow.turns[0].prompt, null);
  assert.equal(flow.turns[0].nodes.length, 0, "the opening SessionStart folds into the turn card");
  assert.equal(flow.turns[0].sessionStart.source, "startup");
  const agent = flow.turns[1].nodes[0];
  assert.equal(agent.branch, true);
  assert.equal(agent.status, "background");
  assert.equal(flow.turns[1].subagentStops, 1);
});
