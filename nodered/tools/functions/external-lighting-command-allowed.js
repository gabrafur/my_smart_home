const data = msg._external_command;
msg.delay = Number(data.policy.confirmation_settle_seconds) * 1000;
msg.external_issued_at = Date.now();
msg.external_operation_id = String(msg._msgid);
const pending = { expected: msg.expected_state, issued_at: msg.external_issued_at,
    verify_after: msg.external_issued_at + msg.delay, operation_id: msg.external_operation_id };
if (data.test_mode) flow.set('external_pending_v1__test', pending);
else flow.set('external_pending_v1', pending, 'persistent');
delete msg.reset;
return msg;
