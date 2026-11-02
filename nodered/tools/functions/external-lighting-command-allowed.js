const data = msg._external_command;
const testMode = data.test_mode === true;
const settleSeconds = Number(data.policy.confirmation_settle_seconds);
const windowSeconds = Number(data.policy.confirmation_window_seconds);
if (!Number.isInteger(settleSeconds) || settleSeconds < 1 || settleSeconds > 30 ||
    !Number.isInteger(windowSeconds) || windowSeconds <= settleSeconds || windowSeconds > 300 ||
    !['on', 'off'].includes(msg.expected_state) ||
    typeof msg._msgid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(msg._msgid)) {
    node.error('external_lighting_confirmation_policy_or_identity_missing', { _global_observer_test: testMode, payload: { test_mode: testMode } });
    return null;
}
msg.delay = settleSeconds * 1000;
msg.external_issued_at = Date.now();
msg.external_operation_id = msg._msgid;
msg.external_verify_after = msg.external_issued_at + msg.delay;
msg.external_expires_at = msg.external_issued_at + windowSeconds * 1000;
msg.external_confirmation_scope = testMode ? 'test' : 'production';
const epochKey = 'external_confirmation_epoch_v2' + (testMode ? '__test' : '');
let epoch = flow.get(epochKey, 'memoryOnly');
if (typeof epoch !== 'string') {
    epoch = `${msg.external_issued_at}:${msg.external_operation_id}`;
    flow.set(epochKey, epoch, 'memoryOnly');
}
const pending = { version: 2, expected: msg.expected_state, issued_at: msg.external_issued_at,
    verify_after: msg.external_verify_after, expires_at: msg.external_expires_at,
    operation_id: msg.external_operation_id, runtime_epoch: epoch };
if (testMode) flow.set('external_pending_v1__test', pending);
else flow.set('external_pending_v1', pending, 'persistent');
delete msg.reset;
return msg;
