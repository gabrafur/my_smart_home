const testMode = msg._host_memory_guardian_test === true || msg.payload?.test_mode === true;
const raw = typeof msg.payload === "string"
    ? msg.payload.replace(/[\r\n]+/g, " ").trim().slice(0, 800)
    : "";
const synthetic = !raw && testMode && msg.payload && typeof msg.payload === "object"
    ? msg.payload
    : null;
if (!raw && !synthetic) return null;

const allowed = new Set([
    "running", "healthy", "pressure_no_safe_duplicate", "pressure_no_safe_candidate",
    "candidate_observed", "candidate_active", "pressure_cooldown", "terminated", "failed"
]);
const status = synthetic?.status ?? raw.match(/\bstatus=([a-z_]+)\b/)?.[1];
if (!allowed.has(status)) {
    if (!testMode) node.error("host_memory_guardian_result_unrecognized");
    node.status({ fill: "red", shape: "ring", text: "resultado inválido" });
    return null;
}
const numberFrom = (name) => {
    const value = synthetic?.[name] ?? raw.match(new RegExp("\\b" + name + "=([0-9.]+)\\b"))?.[1];
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};
const result = {
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
const signature = [result.request_id, result.status, result.checked_at].join(":");
const key = testMode ? "host_memory_guardian_last_result_v1__test" : "host_memory_guardian_last_result_v1";
const previous = testMode ? flow.get(key) : flow.get(key, "persistent");
if (!testMode && previous?.signature === signature) return null;
result.signature = signature;
if (testMode) flow.set(key, result);
else flow.set(key, result, "persistent");

const failed = status === "failed";
const pressure = status !== "healthy" && status !== "running";
node.status({
    fill: failed ? "red" : status === "terminated" ? "yellow" : pressure ? "yellow" : "green",
    shape: failed ? "ring" : "dot",
    text: status === "terminated"
        ? "árvore ociosa encerrada"
        : status === "healthy"
            ? "memória saudável"
            : status.replaceAll("_", " ")
});
msg.payload = result;
if (testMode) return [null, msg];
if (failed) {
    node.error("host_memory_guardian_failed request_id=" + result.request_id);
    return [null, null];
}
if (status === "terminated") {
    node.warn(
        "HOST_MEMORY_GUARDIAN_TERMINATED count=" + String(result.terminated) +
        " reclaimed_candidate_mib=" + String(result.candidate_mib ?? 0) +
        " available_mib=" + String(result.available_mib ?? 0)
    );
}
return [null, null];
