const testMode = msg._git_backup_test === true;
const text = String(msg.payload ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 500);
if (!text) {
    node.status({ fill: "grey", shape: "ring", text: "sem saída; erro tratado separadamente" });
    return null;
}
const status = text.match(/\bstatus=(success|failed|deferred)\b/)?.[1] ?? "invalid";
const reason = text.match(/\breason=([a-z0-9_]+)\b/)?.[1] ?? "unknown";
const finishedAt = text.match(/\bfinished_at=([^ ]+)\b/)?.[1] ?? null;
const requestId = text.match(/\brequest_id=([0-9]{8}T[0-9]{6}Z-[0-9]+)\b/)?.[1] ?? null;
const origin = ["scheduled", "manual"].includes(msg.topic) ? msg.topic : "unknown";
const result = { status, reason, finished_at: finishedAt, request_id: requestId, origin };
if (testMode) flow.set("git_backup_last_result_v1__test", result);
else {
    const previous = flow.get("git_backup_last_result_v1", "persistent");
    const prior = flow.get("git_backup_failure_history_v1", "persistent");
    const safeFailure = value => value?.status === "failed" ? {
        status: "failed",
        reason: /^[a-z0-9_]{1,80}$/.test(value.reason ?? "") ? value.reason : "unknown",
        finished_at: typeof value.finished_at === "string" ? value.finished_at.slice(0, 40) : null,
        request_id: /^[0-9]{8}T[0-9]{6}Z-[0-9]+$/.test(value.request_id ?? "") ? value.request_id : null,
        origin: ["scheduled", "manual"].includes(value.origin) ? value.origin : "unknown",
    } : null;
    const failures = Array.isArray(prior) ? prior.slice(-16).map(safeFailure).filter(Boolean) : [];
    for (const item of [safeFailure(previous), safeFailure(result)]) {
        if (item && !failures.some(old => JSON.stringify(old) === JSON.stringify(item))) failures.push(item);
    }
    flow.set("git_backup_failure_history_v1", failures.slice(-16), "persistent");
    if (origin === "scheduled" && requestId && ["success", "failed", "deferred"].includes(status)) {
        flow.set("git_backup_last_scheduled_result_v1", result, "persistent");
    }
    flow.set("git_backup_last_result_v1", result, "persistent");
}
msg.git_backup_status = status;
msg.payload = { ...result, test_mode: testMode };
return msg;
