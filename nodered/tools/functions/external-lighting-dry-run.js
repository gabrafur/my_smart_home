const result = { version: 1, simulated: true, dispatched: false,
    mqtt_sent: false, alexa_called: false, mobile_notification_sent: false,
    reason: msg.zigbee_error ? "zigbee_offline" : msg.external_lighting_recovery_candidate ? "recovery_prompt" : "command_confirmed",
    completed_at: Date.now() };
flow.set("external_lighting_last_dry_run_v1", result);
node.status({ fill: "blue", shape: "dot", text: `TESTE: ${result.reason}; nenhum efeito` });
return null;
