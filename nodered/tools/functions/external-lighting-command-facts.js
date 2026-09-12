const policy = global.get("external_lighting_policy_v1", "persistent");
if (policy?.version !== 1 || policy?.complete !== true) {
    node.error("iluminacao_externa: política visual ausente", msg);
    return null;
}
const testMode = msg._external_lighting_test === true || msg.payload?.test_mode === true;
const testState = msg._external_test_zigbee_state ?? flow.get("external_lighting_zigbee_state__test");
const zigbeeState = testMode ? testState : flow.get("external_lighting_zigbee_state");
msg._external_command = { test_mode: testMode, zigbee_state: zigbeeState,
    zigbee_offline: zigbeeState === "offline", policy };
return msg;
