// State events can reconcile only a live command expectation; never send a command.
const testMode = msg._external_lighting_test === true;
const suffix = testMode ? '__test' : '';
const store = testMode ? undefined : 'persistent';
const key = 'external_pending_v1' + suffix;
const pending = flow.get(key, store);
if (!pending) return null;
const now = Date.now();
const epoch = flow.get('external_confirmation_epoch_v2' + suffix, 'memoryOnly');
const valid = pending.version === 2 && typeof pending.operation_id === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(pending.operation_id) && ['on', 'off'].includes(pending.expected) &&
    Number.isFinite(pending.issued_at) && Number.isFinite(pending.verify_after) && Number.isFinite(pending.expires_at) &&
    pending.issued_at < pending.verify_after && pending.verify_after < pending.expires_at &&
    pending.issued_at <= now && typeof epoch === 'string' && pending.runtime_epoch === epoch;
if (!valid || now >= pending.expires_at) {
    flow.set(key, null, store);
    flow.set('external_confirmation_expectation_v2' + suffix, { version: 2,
        operation_id: typeof pending.operation_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(pending.operation_id) ? pending.operation_id : null,
        status: valid ? 'expired' : 'discarded', reason: valid ? 'deadline_elapsed' : 'legacy_or_runtime_context_invalid',
        closed_at: now }, store);
    return null;
}
if (now < pending.verify_after) return null;
msg.expected_state = pending.expected;
msg.external_issued_at = pending.issued_at;
msg.external_operation_id = pending.operation_id;
msg.external_verify_after = pending.verify_after;
msg.external_expires_at = pending.expires_at;
msg.external_confirmation_scope = testMode ? 'test' : 'production';
msg.source = 'state_reconciliation';
msg._external_command = { test_mode: testMode };
return msg;
