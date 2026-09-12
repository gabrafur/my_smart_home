const testMode = msg.test_mode === true;
const key = testMode ? "local_ai_rtx_recovery_v1__test" : "local_ai_rtx_recovery_v1";
const store = testMode ? undefined : "persistent";
const previous = store ? flow.get(key, store) || {} : flow.get(key) || {};
const transition = String(msg.rtx_transition || "status");
const snapshot = { ...previous, ...msg.rtx_status };
if (transition === "available") snapshot.last_result = "available";
else if (transition === "unavailable") snapshot.last_result = "unavailable";
else if (transition === "cooldown") snapshot.last_result = "cooldown";
else if (transition === "recovery_requested") {
    snapshot.last_attempt_at = Number(msg.rtx_now) || Date.now();
    snapshot.last_result = "recovery_requested";
}
if (store) flow.set(key, snapshot, store);
else flow.set(key, snapshot);
msg.rtx_status = snapshot;
msg.payload = transition === "recovery_requested"
    ? { requested: true, reason: snapshot.reason }
    : snapshot;
return msg;
