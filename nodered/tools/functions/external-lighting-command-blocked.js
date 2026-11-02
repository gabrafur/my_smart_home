msg.zigbee_error = true;
msg.cancel_confirmation = true;
msg.reset = true;
const testMode = msg._external_command?.test_mode === true;
msg.external_confirmation_scope = testMode ? 'test' : 'production';
const suffix = testMode ? '__test' : '';
const store = testMode ? undefined : 'persistent';
const pendingKey = 'external_pending_v1' + suffix;
const pending = flow.get(pendingKey, store);
if (pending) {
    flow.set(pendingKey, null, store);
    flow.set('external_confirmation_expectation_v2' + suffix, { version: 2,
        operation_id: typeof pending.operation_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(pending.operation_id) ? pending.operation_id : null,
        status: 'cancelled', reason: 'Zigbee_command_blocked', closed_at: Date.now() }, store);
}
msg.notify_text = "Erro na rede Zigbee. A iluminação externa não foi acionada e o comando não será repetido.";
node.status({ fill: "red", shape: "ring", text: "comando bloqueado: Zigbee offline" });
return msg;
