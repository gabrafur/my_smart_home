const key = msg.test_mode === true ? "local_ai_rtx_recovery_v1__test" : "local_ai_rtx_recovery_v1";
const previous = flow.get(key) || {};
const seconds = Number(msg.policy?.recovery_cooldown_seconds);
if (!Number.isFinite(seconds)) {
    node.error("Política visual RTX indisponível", msg);
    return null;
}
msg.rtx_status = { ...msg.rtx_status, last_attempt_at: Number(previous.last_attempt_at) || null };
msg.rtx_cooldown_until = Number(previous.last_attempt_at || 0) + seconds * 1000;
return msg;
