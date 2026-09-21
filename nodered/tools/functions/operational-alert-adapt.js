// Normalize already-classified decisions; never authorize a host/device effect.
const item = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const policy = msg.operational_alert;
const testMode = msg._ha_updates_test === true || msg._repository_dependency_test === true ||
    msg._host_memory_guardian_test === true || item.test_mode === true;
const subject = policy.source === "guardiao_memoria_host" ? "memory_pressure" : String(item.entity_id ?? item.package ?? "");
if (!subject) return null;
msg.operational_alert = {
    ...policy, subject, test_mode: testMode,
    version: String(item.latest_version ?? item.to ?? item.version ?? "unknown"),
    message: policy.message + (policy.source === "atualizacoes_diarias" ? " Item: " + subject + "." : "")
};
return msg;
