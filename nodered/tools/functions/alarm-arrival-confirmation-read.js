const action = msg.payload?.event?.action ?? msg.payload?.action ?? msg.event?.action ?? null;
const now = Number(msg.arrival_now ?? Date.now());
let testPending = flow.get("alarm_arrival_test_pending_confirmation");
const pending = flow.get("alarm_arrival_pending_confirmation");
const shared = global.get("security_location_test_state_v1") ?? {};
const resetAt = Math.max(Number(shared.reset_at ?? 0) || 0, Number(global.get("alarm_arrival_test_reset_at") ?? 0) || 0);
if (testPending && resetAt > 0 && Number(testPending.createdAt ?? 0) <= resetAt) {
    flow.set("alarm_arrival_test_pending_confirmation", null);
    testPending = null;
}
msg.confirmation = {
    action, now, action_valid: typeof action === "string" && action.length > 0,
    is_test: typeof action === "string" && action.startsWith("ALARME_TESTE_"),
    test_pending: testPending, test_pending_exists: Boolean(testPending),
    test_token_matches: action === testPending?.confirmAction || action === testPending?.cancelAction,
    test_expired: !Number.isFinite(Number(testPending?.expiresAt)) || now > Number(testPending?.expiresAt),
    pending, pending_exists: Boolean(pending),
    pending_expired: !Number.isFinite(Number(pending?.expiresAt)) || now > Number(pending?.expiresAt),
    is_cancel: action === pending?.cancelAction, is_confirm: action === pending?.confirmAction
};
return msg;
