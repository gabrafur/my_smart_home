const testMode = msg._host_memory_guardian_test === true || msg.payload?.test_mode === true;
const raw = typeof msg.payload === "string"
    ? msg.payload.replace(/[\r\n]+/g, " ").trim().slice(0, 800)
    : "";
const synthetic = !raw && testMode && msg.payload && typeof msg.payload === "object"
    ? msg.payload
    : null;

msg._host_memory_guardian_test = testMode;
if (!raw && !synthetic) {
    msg.guardian_result_present = false;
    msg.guardian_protocol_valid = false;
    msg.guardian_status = "no_result";
    msg.payload = { version: 1, status: "no_result", test_mode: testMode };
    return msg;
}

const allowed = new Set([
    "running", "healthy", "pressure_no_safe_duplicate", "pressure_no_safe_candidate",
    "candidate_observed", "candidate_active", "pressure_cooldown", "terminated", "failed"
]);
const status = synthetic?.status ?? raw.match(/\bstatus=([a-z_]+)\b/)?.[1] ?? "invalid";
const numberFrom = (name) => {
    const value = synthetic?.[name] ?? raw.match(new RegExp("\\b" + name + "=([0-9.]+)\\b"))?.[1];
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

msg.guardian_result_present = true;
msg.guardian_protocol_valid = allowed.has(status);
msg.guardian_status = status;
msg.payload = {
    version: 1,
    status,
    request_id: synthetic?.request_id ?? raw.match(/\brequest_id=([^ ]+)\b/)?.[1] ?? "test",
    available_mib: numberFrom("available_mib"),
    available_percent: numberFrom("available_percent"),
    candidate_pid: synthetic?.candidate_pid ?? raw.match(/\bcandidate_pid=([^ ]+)\b/)?.[1] ?? "none",
    candidate_mib: numberFrom("candidate_mib"),
    terminated: numberFrom("terminated") ?? 0,
    checked_at: synthetic?.checked_at ?? raw.match(/\bchecked_at=([^ ]+)\b/)?.[1] ?? new Date().toISOString(),
    test_mode: testMode,
    simulated: testMode,
    dispatched: !testMode && status === "terminated"
};
return msg;
