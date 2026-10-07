const result = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const testMode = msg._host_memory_guardian_test === true || result.test_mode === true;
const forceStale = testMode && msg._host_memory_guardian_force_stale === true;
const expected = testMode ? null : flow.get("host_memory_guardian_expected_request_v1", "memoryOnly");
const requestId = String(result.request_id ?? "");
const expectedIds = expected?.request_ids ?? (expected?.request_id ? [expected.request_id] : []);
if (!testMode && !expectedIds.includes(requestId)) {
    node.status({ fill: "yellow", shape: "ring", text: "aguardando resultado do ciclo atual" });
    return null;
}
const maximumAgeSeconds = Number(msg.guardian_max_age_seconds);
const checkedAt = Date.parse(String(result.checked_at ?? ""));
const ageMs = Date.now() - checkedAt;
msg.guardian_result_age_seconds = Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null;
msg.guardian_result_fresh = !forceStale && (testMode || (
    Number.isFinite(maximumAgeSeconds) && maximumAgeSeconds > 0 &&
    Number.isFinite(ageMs) && ageMs >= -30000 && ageMs <= maximumAgeSeconds * 1000
));
return msg;
