const now = Number(msg.arrival_now ?? Date.now());
let existing = flow.get("alarm_arrival_test_pending_confirmation");
const shared = global.get("security_location_test_state_v1") ?? {};
const resetAt = Math.max(Number(shared.reset_at ?? 0) || 0, Number(global.get("alarm_arrival_test_reset_at") ?? 0) || 0);
const createdAt = Number(existing?.createdAt ?? 0);
const invalidated = existing && resetAt > 0 && (!Number.isFinite(createdAt) || createdAt <= resetAt);
const expired = existing && (!Number.isFinite(Number(existing.expiresAt)) || Number(existing.expiresAt) <= now);
if (invalidated || expired) {
    flow.set("alarm_arrival_test_pending_confirmation", null);
    existing = null;
}
msg.arrival_test = {
    now, reset_at: resetAt, existing,
    pending_active: Number(existing?.expiresAt) > now
};
return msg;
