import assert from "node:assert/strict";
import test from "node:test";
import { inspectActivity, readActivity } from "./codex-remote-activity.mjs";
import { restartCodexRemote, preflightCodexRestart } from "./codex-remote-recovery.mjs";

const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
function fake({ state = "idle", goal = null, changed = false } = {}) {
  const calls = []; let lists = 0;
  return { calls, invoke: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/loaded/list") return { data: changed && lists++ > 0 ? [] : [id] };
    if (method === "thread/read") return { thread: { id, status: { type: state } } };
    if (method === "thread/goal/get") return { goal };
    throw Error("unexpected method");
  } };
}

test("an active turn prevents restart without reading turns or starting inference", async () => {
  const f = fake({ state: "active" }); const out = await inspectActivity(f.invoke);
  assert.equal(out.state, "busy"); assert.equal(out.reason, "active_turn");
  assert.deepEqual(f.calls.map(c => c.method), ["thread/loaded/list", "thread/read"]);
  assert.deepEqual(f.calls[1].params, { threadId: id, includeTurns: false });
});

test("active goal remains busy between turns and private objective is withheld", async () => {
  const f = fake({ goal: { threadId: id, status: "active", objective: "withheld-fixture" } });
  const out = await inspectActivity(f.invoke);
  assert.equal(out.state, "busy"); assert.equal(out.reason, "active_goal");
  assert.equal(JSON.stringify(out).includes("withheld-fixture"), false);
});

test("idle requires known inactive goals and a complete unchanged loaded scope", async () => {
  for (const status of [null, "paused", "blocked", "usageLimited", "budgetLimited", "complete"]) {
    const f = fake({ goal: status ? { threadId: id, status } : null });
    assert.equal((await inspectActivity(f.invoke)).state, "idle");
    assert.equal(f.calls.filter(c => c.method === "thread/loaded/list").length, 2);
  }
  assert.equal((await inspectActivity(fake({ changed: true }).invoke)).state, "unknown");
});

test("unloaded, failed or missing observations never mean inactivity", async () => {
  for (const state of ["notLoaded", "systemError", null])
    assert.equal((await inspectActivity(fake({ state }).invoke)).state, "unknown");
  for (const listed of [{ data: [id], nextCursor: "more" }, { data: [id, id] },
    { data: ["invalid"] }, {}, { data: Array(65).fill(id) }])
    assert.equal((await inspectActivity(async () => listed)).state, "unknown");
  assert.equal((await inspectActivity(async () => { throw Error("withheld"); })).state, "unknown");
  const f = fake();
  assert.equal((await inspectActivity((method, params) => method === "thread/goal/get" ? {} : f.invoke(method, params))).state, "unknown");
});

test("busy or unknown activity never sends a termination signal or starts another server", () => {
  for (const state of ["busy", "unknown", undefined]) {
    const activity = () => ({ state, no_effects: true });
    assert.equal(preflightCodexRestart({ activity }).status, "deferred");
    const out = restartCodexRemote({ activity, run: () => ({ status: 0 }),
      terminate: () => assert.fail("must not terminate"), launch: () => assert.fail("must not launch") });
    assert.equal(out.status, "deferred");
  }
});

test("activity child errors and malformed output remain closed and never export stderr", () => {
  for (const result of [{ status: 1, stderr: "withheld" }, { status: 0, stdout: "invalid" },
    { status: 0, stdout: '{"state":"idle"}' }]) {
    const out = readActivity("/fixture/socket", { run: () => result });
    assert.equal(out.state, "unknown"); assert.equal(JSON.stringify(out).includes("withheld"), false);
  }
});
