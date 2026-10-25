import test from "node:test";
import assert from "node:assert/strict";
import { auditFailureCategory } from "./kia-uvo-audit-failure.mjs";

test("fetch cause yields a closed category without private exception text", () => {
  const cause = Object.assign(new Error("private credentials sentinel"), {code:"UND_ERR_CONNECT_TIMEOUT"});
  assert.equal(auditFailureCategory(new TypeError("fetch failed", {cause})), "connect_timeout");
});

test("old unknown, missing, cyclic and hostile errors remain unknown", () => {
  const cycle = {}; cycle.cause = cycle;
  const hostile = { get code() { throw new Error("private sentinel"); } };
  for (const error of [undefined, null, "private sentinel", {}, cycle, hostile,
    {message:"UND_ERR_CONNECT_TIMEOUT private sentinel"}, {code:"private sentinel"}]) {
    assert.equal(auditFailureCategory(error), "audit_failed_unclassified");
  }
});

test("nested causes are bounded and never parse messages", () => {
  assert.equal(auditFailureCategory({cause:{code:"EAI_AGAIN"}}), "dns_resolution_failed");
  assert.equal(auditFailureCategory({cause:{cause:{cause:{cause:{code:"EAI_AGAIN"}}}}}), "audit_failed_unclassified");
  assert.equal(auditFailureCategory({code:"CERT_HAS_EXPIRED"}), "tls_verification_failed");
});
