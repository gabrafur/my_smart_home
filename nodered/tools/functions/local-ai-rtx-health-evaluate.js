const testMode = msg.test_mode === true || msg._rtx_test === true;
const explicitRecovery = msg.explicit_recovery === true;
const now = Number(msg.rtx_now) || Date.now();
let payload = msg.payload;
if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
}
const localAi = payload && typeof payload === "object"
    ? (payload.local_ai && typeof payload.local_ai === "object" ? payload.local_ai : payload)
    : {};
const preflight = localAi.preflight && typeof localAi.preflight === "object" ? localAi.preflight : {};
const state = String(localAi.state || preflight.state || "LOCAL_AI_UNKNOWN");
const available = localAi.available === true || ["LOCAL_AI_AVAILABLE", "LOCAL_AI_DEGRADED"].includes(state);
const reason = String(preflight.reason || localAi.reason || (available ? "available" : "unknown"));
const key = testMode ? "local_ai_rtx_recovery_v1__test" : "local_ai_rtx_recovery_v1";
const previous = flow.get(key) || {};
const snapshot = {
    state,
    available,
    reason,
    checked_at: preflight.checked_at || new Date(now).toISOString(),
    last_attempt_at: Number(previous.last_attempt_at) || null,
    last_result: previous.last_result || null,
};
const status = { ...msg, test_mode: testMode, rtx_status: snapshot, payload: snapshot };
if (available) {
    snapshot.last_result = "available";
    flow.set(key, snapshot);
    node.status({ fill: "green", shape: "dot", text: "RTX disponível" });
    return [status, null];
}
if (!explicitRecovery) {
    snapshot.last_result = "unavailable";
    flow.set(key, snapshot);
    node.status({ fill: "red", shape: "ring", text: `indisponível: ${reason}` });
    return [status, null];
}
const coolingDown = snapshot.last_attempt_at && now - snapshot.last_attempt_at < 60000;
if (coolingDown && !testMode) {
    snapshot.last_result = "cooldown";
    flow.set(key, snapshot);
    node.status({ fill: "yellow", shape: "ring", text: `aguardando: ${reason}` });
    return [status, null];
}
snapshot.last_attempt_at = now;
snapshot.last_result = "recovery_requested";
flow.set(key, snapshot);
node.status({ fill: "yellow", shape: "dot", text: `recovery: ${reason}` });
const recovery = { ...msg, test_mode: testMode, rtx_status: snapshot, payload: { requested: true, reason } };
return [status, recovery];
