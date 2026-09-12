const feeder = String(msg.payload?.feeder ?? "42");
const relay = String(msg.payload?.relay ?? "on");
msg.tuya_entity_registry = [
    { entity_id: "sensor.test_feeder_level", device_id: "device-test-feeder", platform: "tuya", disabled_by: null, original_name: "Nível" },
    { entity_id: "button.test_feeder_feed", device_id: "device-test-feeder", platform: "tuya", disabled_by: null, original_name: "Alimentar" },
    { entity_id: "switch.test_local_relay", device_id: "device-test-relay", platform: "localtuya", disabled_by: null, original_name: "Relé" }
];
msg.tuya_device_registry = [
    { id: "device-test-feeder", name_by_user: "Comedouro de teste" },
    { id: "device-test-relay", name: "Relé local de teste" }
];
msg.tuya_states = [
    { entity_id: "sensor.test_feeder_level", state: feeder, attributes: { friendly_name: "Comedouro de teste" } },
    { entity_id: "button.test_feeder_feed", state: "unknown", attributes: {} },
    { entity_id: "switch.test_local_relay", state: relay, attributes: { friendly_name: "Relé local de teste" } }
];
return msg;
