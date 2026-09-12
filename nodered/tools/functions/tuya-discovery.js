const device = {
    identifiers: ["node_red_infrastructure_monitoring"], name: "Monitoramento de infraestrutura",
    manufacturer: "Node-RED", model: "Flows de disponibilidade"
};
const availability = { availability_topic: "nodered/status", payload_available: "online", payload_not_available: "offline" };
return [[
    { topic: "homeassistant/binary_sensor/tuya_devices/config", payload: JSON.stringify({
        name: "Dispositivos Tuya", object_id: "tuya_devices",
        default_entity_id: "binary_sensor.tuya_devices", unique_id: "node_red_tuya_devices",
        device_class: "connectivity", state_topic: "nodered/infrastructure/tuya/connection",
        json_attributes_topic: "nodered/infrastructure/tuya/attributes",
        payload_on: "ON", payload_off: "OFF", ...availability, device
    }) },
    { topic: "homeassistant/sensor/tuya_devices_state/config", payload: JSON.stringify({
        name: "Estado dos dispositivos Tuya", object_id: "tuya_devices_state",
        default_entity_id: "sensor.tuya_devices_state", unique_id: "node_red_tuya_devices_state",
        icon: "mdi:access-point-network", entity_category: "diagnostic",
        state_topic: "nodered/infrastructure/tuya/state",
        json_attributes_topic: "nodered/infrastructure/tuya/attributes", ...availability, device
    }) }
]];
