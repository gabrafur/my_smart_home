// Normalize already-classified decisions; never authorize a host/device effect.
const item = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const policy = msg.operational_alert;
const testMode = msg._ha_updates_test === true || msg._repository_dependency_test === true ||
    msg._host_memory_guardian_test === true || item.test_mode === true;
const guardianFailure = policy.source === "guardiao_memoria_host" && policy.subject === "memory_guardian_failure";
const clean = (value, fallback) => String(value ?? fallback).replace(/[^A-Za-z0-9_.:= -]/g, "_").slice(0, 160);
const subject = policy.subject ?? (policy.source === "guardiao_memoria_host" ? "memory_pressure" : String(item.entity_id ?? item.package ?? ""));
if (!subject) return null;
msg.operational_alert = {
    ...policy, subject, test_mode: testMode,
    reason: guardianFailure ? clean(item.reason, item.status ?? "unknown") : policy.reason,
    version: guardianFailure
        ? clean(String(item.status ?? "invalid") + ":" + String(item.reason ?? "none"), "unknown")
        : String(item.latest_version ?? item.to ?? item.version ?? "unknown"),
    message: policy.message + (policy.source === "atualizacoes_diarias"
        ? " Item: " + subject + "."
        : guardianFailure ? " Status: " + clean(item.status, "invalid") + ". Motivo: " + clean(item.reason, "none") + "." : "")
};
return msg;
