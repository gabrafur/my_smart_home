#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
const load = (name) => new Function("msg", "flow", "node", fs.readFileSync(new URL(`./functions/${name}.js`, import.meta.url), "utf8"));
const normalize = load("host-memory-guardian-request-response-normalize");
const invalid = load("host-memory-guardian-request-invalid");
function run(input) {
  const updates = [];
  const errors = [];
  const flow = { get: () => undefined, set: (...args) => updates.push(args) };
  const node = { status() {}, error: (text) => errors.push(text) };
  const result = normalize(structuredClone(input), flow, node);
  if (result.guardian_request_status === "invalid") invalid(result, flow, node);
  return { result, updates, errors };
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
  assert.match(errors[0], new RegExp(`reason=${reason} exit_code=${code} signal=${signal}$`));
  assert.doesNotMatch(errors[0], /PRIVATE/);
}
for (const id of ["busy", "pending"]) {
  const { result, updates, errors } = run({ payload: `host-memory-guardian-request status=coalesced request_id=${id}`, rc: { code: 0 } });
  assert.equal(result.guardian_request_status, "coalesced");
  assert.equal(updates.length, 0);
  assert.equal(errors.length, 0);
}
console.log("Host memory guardian request diagnostics: exact acknowledgements, process failures, empty output and private-output exclusion passed.");
