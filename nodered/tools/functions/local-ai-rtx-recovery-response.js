const testMode = msg.test_mode === true || msg._rtx_test === true;
let payload = msg.payload;
if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
}
const localAi = payload && typeof payload === "object" && payload.local_ai && typeof payload.local_ai === "object"
    ? payload.local_ai
    : (payload || {});
const state = String(localAi.state || "LOCAL_AI_UNKNOWN");
const available = localAi.available === true || ["LOCAL_AI_AVAILABLE", "LOCAL_AI_DEGRADED"].includes(state);
const reason = String(localAi.reason || (available ? "endpoint_recovered" : "mcp_recovery_failed"));
const key = testMode ? "local_ai_rtx_recovery_v1__test" : "local_ai_rtx_recovery_v1";
const previous = flow.get(key) || {};
const result = {
    ...previous,
    state,
    available,
    reason,
    last_result: available ? "recovered" : "failed",
    recovery_attempted: localAi.recovery_attempted === true,
    recovery_succeeded: localAi.recovery_succeeded === true,
    recovery_attempts: Number(localAi.recovery_attempts) || 0,
};
flow.set(key, result);
node.status(available
    ? { fill: "green", shape: "dot", text: "endpoint restaurado" }
    : { fill: "red", shape: "ring", text: `falha: ${reason}` });
msg.rtx_status = result;
msg.payload = result;
return msg;
