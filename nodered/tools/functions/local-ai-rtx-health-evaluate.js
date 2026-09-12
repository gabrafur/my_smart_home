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
const snapshot = {
    state,
    available,
    reason,
    checked_at: preflight.checked_at || new Date(now).toISOString(),
};
msg.test_mode = testMode;
msg.explicit_recovery = explicitRecovery;
msg.rtx_now = now;
msg.rtx_status = snapshot;
msg.payload = snapshot;
return msg;
