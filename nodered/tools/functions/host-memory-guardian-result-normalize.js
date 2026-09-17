const testMode = msg._host_memory_guardian_test === true || msg.payload?.test_mode === true;
const raw = typeof msg.payload === "string" ? msg.payload.replace(/[\r\n]+/g, " ").trim().slice(0, 800) : "";
const data = !raw && testMode && msg.payload && typeof msg.payload === "object" ? msg.payload : null;

msg._host_memory_guardian_test = testMode;
if (!raw && !data) {
    msg.guardian_result_present = false;
    msg.guardian_protocol_valid = false;
    msg.guardian_status = "no_result";
    msg.payload = { version: 1, status: "no_result", test_mode: testMode };
    return msg;
}

const allowed = new Set("running healthy pressure_no_safe_duplicate pressure_no_safe_candidate candidate_observed candidate_active pressure_cooldown terminated reclaimed cleanup_partial failed".split(" "));
const text = (name, fallback = "") => data?.[name] ?? raw.match(new RegExp("\\b" + name + "=([^ ]+)\\b"))?.[1] ?? fallback;
const status = text("status", "invalid");
const num = (name) => {
    const value = data?.[name] ?? raw.match(new RegExp("\\b" + name + "=([0-9.]+)\\b"))?.[1];
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

msg.guardian_result_present = true;
msg.guardian_protocol_valid = allowed.has(status);
msg.guardian_status = status;
msg.payload = {
    version: 1,
    status,
    reason: text("reason", "none"),
    request_id: text("request_id", "test"),
    available_mib: num("available_mib"),
    available_percent: num("available_percent"),
    candidate_pid: text("candidate_pid", "none"),
    candidate_mib: num("candidate_mib"),
    terminated: num("terminated") ?? 0,
    temp_removed: num("temp_removed") ?? 0,
    temp_reclaimed_mib: num("temp_reclaimed_mib") ?? 0,
    cleanup_errors: num("cleanup_errors") ?? 0,
    checked_at: text("checked_at", "invalid"),
    test_mode: testMode,
    simulated: testMode,
    dispatched: !testMode && (status === "terminated" || status === "reclaimed" || num("temp_removed") > 0)
};
return msg;
