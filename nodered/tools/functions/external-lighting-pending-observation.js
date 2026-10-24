// State events can reconcile a pending intention; this function never sends a command.
const pending = flow.get('external_pending_v1', 'persistent');
if (!pending || Date.now() < pending.verify_after || !['on', 'off'].includes(pending.expected)) return null;
msg.expected_state = pending.expected;
msg.external_issued_at = pending.issued_at;
msg.external_operation_id = pending.operation_id;
msg.source = 'state_reconciliation';
msg._external_command = { test_mode: false };
return msg;
