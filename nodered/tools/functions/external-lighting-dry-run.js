const result = { version: 1, simulated: true, dispatched: false,
    mqtt_sent: false, alexa_called: false, mobile_notification_sent: false,
    expected_state: msg.expected_state ?? null,
    reason: msg.zigbee_error ? "zigbee_offline" : msg.external_lighting_recovery_candidate ? "recovery_confirmation" : "command_confirmed",
    completed_at: Date.now() };
flow.set("external_lighting_last_dry_run_v1", result);
node.status({ fill: "blue", shape: "dot", text: `TESTE: ${result.reason}; 0 efeitos` });
return null;
