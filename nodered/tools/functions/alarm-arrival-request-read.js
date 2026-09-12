const now = Number(msg.arrival_now ?? Date.now());
const pending = flow.get("alarm_arrival_pending_confirmation");
const inflight = flow.get("alarm_arrival_confirmation_inflight");
const last = Number(flow.get("alarm_arrival_last_confirmation_at") || 0);
msg.arrival_request = {
    now,
    pending_active: Number(pending?.expiresAt) > now,
    inflight_active: Number(inflight?.expiresAt) > now,
    cooldown_active: Number.isFinite(last) && last > 0 && last <= now + 60000 && now - last < msg.policy.cooldown_s * 1000
};
return msg;
