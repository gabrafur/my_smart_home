#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
const load = (name) => new Function("msg", "flow", "node", fs.readFileSync(new URL(`./functions/${name}.js`, import.meta.url), "utf8"));
const normalize = load("host-memory-guardian-request-response-normalize");
const invalid = load("host-memory-guardian-request-invalid");
function run(input, context = new Map()) {
  const updates = [];
  const errors = [];
  const warnings = [];
  const flow = {
    get: (key) => context.get(key),
    set: (key, value, store) => {
      if (key === "host_memory_guardian_request_stalls_v1") context.set(key, value);
      else updates.push([key, value, store]);
    },
  };
  const node = { status() {}, error: (text) => errors.push(text), warn: (text) => warnings.push(text) };
  const result = normalize(structuredClone(input), flow, node);
  if (result.guardian_request_status === "invalid") invalid(result, flow, node);
  return { result, updates, errors, warnings, context };
}
for (const status of ["accepted", "coalesced"]) {
  const { result, updates, errors } = run({ payload: `host-memory-guardian-request status=${status} request_id=fixture-1 lock_recovered=false\n`, rc: { code: 0 } });
  assert.equal(result.guardian_request_status, status);
  assert.equal(updates.length, 1);
  assert.equal(errors.length, 0);
}
for (const [input, reason, code, signal] of [
  [{ payload: "", rc: { code: null, signal: "SIGTERM", message: "PRIVATE command" } }, "execution_interrupted", "unknown", "SIGTERM"],
  [{ payload: "", rc: { code: 73, message: "PRIVATE path" } }, "execution_failed", 73, "none"],
  [{ payload: "", rc: { code: 0 } }, "empty_response", 0, "none"],
  [{ payload: "PRIVATE malformed response", rc: { code: 0 } }, "invalid_response", 0, "none"],
  [{ payload: "host-memory-guardian-request status=accepted request_id=fixture-2", rc: { code: 1 } }, "execution_failed", 1, "none"],
  [{ payload: "PRIVATE status=accepted request_id=fixture-2", rc: { code: 0 } }, "invalid_response", 0, "none"],
]) {
  const { result, updates, errors } = run(input);
  assert.equal(result.guardian_request_status, "invalid");
  assert.equal(updates.length, 0, "failed response must not admit a new expected request");
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`reason=${reason} exit_code=${code} signal=${signal} elapsed_ms=unknown$`));
  assert.doesNotMatch(errors[0], /PRIVATE/);
}
for (const id of ["busy", "pending"]) {
  const { result, updates, errors } = run({ payload: `host-memory-guardian-request status=coalesced request_id=${id}`, rc: { code: 0 } });
  assert.equal(result.guardian_request_status, "coalesced");
  assert.equal(updates.length, 0);
  assert.equal(errors.length, 0);
}
console.log("Host memory guardian request diagnostics: exact acknowledgements, process failures, empty output and private-output exclusion passed.");

// A SIGTERM at the exec limit is a host stall: transient twice per hour, failure on the third.
const stalls = new Map();
const stalled = () => run({ payload: "", rc: { code: null, signal: "SIGTERM" }, guardian_request_started_at: Date.now() - 22179 }, stalls);
for (const count of [1, 2]) {
  const timed = stalled();
  assert.ok(timed.result.guardian_request_diagnostic.elapsed_ms >= 22179);
  assert.equal(timed.errors.length, 0, "a host stall below the recurrence threshold must not raise an incident");
  assert.equal(timed.updates.length, 0);
  assert.match(timed.warnings[0], new RegExp(`^host_memory_guardian_request_transient reason=host_stall_timeout signal=SIGTERM elapsed_ms=\\d+ recent_1h=${count}$`));
}
const recurrent = stalled();
assert.equal(recurrent.warnings.length, 0);
assert.match(recurrent.errors[0], /^host_memory_guardian_request_unrecognized reason=execution_interrupted exit_code=unknown signal=SIGTERM elapsed_ms=\d+$/);
assert.equal(recurrent.context.get("host_memory_guardian_request_stalls_v1").length, 3);
// Stalls older than one hour no longer count.
const aged = new Map([["host_memory_guardian_request_stalls_v1", [Date.now() - 3600001, Date.now() - 3700000]]]);
const fresh = run({ payload: "", rc: { code: null, signal: "SIGTERM" }, guardian_request_started_at: Date.now() - 15000 }, aged);
assert.equal(fresh.errors.length, 0);
assert.match(fresh.warnings[0], /recent_1h=1$/);
// An interruption well before the limit, or another signal, is still a failure.
for (const input of [
  { payload: "", rc: { code: null, signal: "SIGTERM" }, guardian_request_started_at: Date.now() - 3000 },
  { payload: "", rc: { code: null, signal: "SIGKILL" }, guardian_request_started_at: Date.now() - 15000 },
]) {
  const early = run(input);
  assert.equal(early.warnings.length, 0);
  assert.match(early.errors[0], /reason=execution_interrupted /);
}
console.log("Host memory guardian request diagnostics: host stalls at the exec limit stay transient until the third within an hour.");
