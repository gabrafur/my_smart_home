// Synthetic inputs only. No services, private state, sockets or device calls.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sanitizer = require("./lib/content_sanitizer.cjs");
const exported = require("../../scripts/raspberry-mcp/runtime-source/ha-notices/content_sanitizer.cjs");
const exact = "host_memory_guardian_request_unrecognized reason=execution_failed exit_code=143 signal=none elapsed_ms=17000";

test("exact synthetic guardian diagnostic projects scalars without inferring signal or cause", () => {
  const dto = sanitizer.errorDTO({ message: exact });
  assert.deepEqual(dto.guardian_request, {
    schema_version: 1, source: "host_memory_guardian_request_unrecognized",
    reason: "execution_failed", exit_code: 143, signal: null, elapsed_ms: 17000
  });
  assert.equal(dto.collection_error, null);
  assert.equal(Object.hasOwn(dto.guardian_request, "termination_origin"), false);
  assert.deepEqual(exported.errorDTO({ message: exact }), dto);
});

test("unknown scalars and a canonical observed signal retain their own meanings", () => {
  const unknown = sanitizer.errorDTO({ message: exact.replace("exit_code=143 signal=none elapsed_ms=17000",
    "exit_code=unknown signal=SIGTERM elapsed_ms=unknown") }).guardian_request;
  assert.equal(unknown.exit_code, null);
  assert.equal(unknown.signal, "SIGTERM");
  assert.equal(unknown.elapsed_ms, null);
});

test("prefixes, suffixes, secrets, newlines, unknown reasons and signals cannot enter structured output", () => {
  const syntheticCredentialURL = new URL("https://example.invalid/");
  syntheticCredentialURL.username = "fixture-user";
  syntheticCredentialURL.password = "fixture-secret";
  for (const message of [
    "token=fixture-secret " + exact,
    exact + " token=fixture-secret",
    exact + "\n",
    exact.replace("execution_failed", "token_fixture_secret"),
    exact.replace("signal=none", "signal=SIGSECRET"),
    exact.replace("exit_code=143", "exit_code=9007199254740992"),
    exact.replace("elapsed_ms=17000", "elapsed_ms=-1"),
    exact.replace("elapsed_ms=17000", "elapsed_ms=9007199254740992"),
    exact + "\u0000",
    syntheticCredentialURL.href + " " + exact
  ]) {
    const dto = sanitizer.errorDTO({ message });
    assert.equal(Object.hasOwn(dto, "guardian_request"), false);
    assert.equal(JSON.stringify(dto).includes("fixture-secret"), false);
  }
});

test("catalog preserves storage and adds exactly reviewed guardian context", () => {
  assert.deepEqual(sanitizer.contextDTO("storage_health_tab", "storage_maintenance_complete"),
    { flow: "storage_health_tab", node: "storage_maintenance_complete" });
  assert.deepEqual(sanitizer.contextDTO("host_memory_guardian_tab", "host_memory_guardian_request_invalid"),
    { flow: "host_memory_guardian_tab", node: "host_memory_guardian_request_invalid" });
  assert.deepEqual(sanitizer.contextDTO("token=fixture-secret", "../private"), { flow: null, node: null });
});

test("legacy error DTO remains backward compatible", () => {
  const dto = sanitizer.errorDTO({ message: "service not available" });
  assert.equal(Object.hasOwn(dto, "guardian_request"), false);
  assert.ok(dto.reason_codes.includes("service_unavailable"));
});
