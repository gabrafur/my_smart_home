const device = {
    identifiers: ["node_red_infrastructure_monitoring"],
    name: "Monitoramento de infraestrutura",
    manufacturer: "Node-RED",
    model: "Flows de disponibilidade"
};
const availability = {
    availability_topic: "nodered/status",
    payload_available: "online",
    payload_not_available: "offline"
};
return [[
    { topic: "homeassistant/binary_sensor/zigbee_network/config", payload: JSON.stringify({
        name: "Rede Zigbee", object_id: "zigbee_network",
        default_entity_id: "binary_sensor.zigbee_network", unique_id: "node_red_zigbee_network",
        device_class: "connectivity", state_topic: "nodered/infrastructure/zigbee/connection",
        json_attributes_topic: "nodered/infrastructure/zigbee/attributes",
        payload_on: "ON", payload_off: "OFF", ...availability, device
    }) },
    { topic: "homeassistant/sensor/zigbee_network_state/config", payload: JSON.stringify({
        name: "Estado da rede Zigbee", object_id: "zigbee_network_state",
        default_entity_id: "sensor.zigbee_network_state", unique_id: "node_red_zigbee_network_state",
        icon: "mdi:zigbee", entity_category: "diagnostic",
        state_topic: "nodered/infrastructure/zigbee/state",
        json_attributes_topic: "nodered/infrastructure/zigbee/attributes",
        ...availability, device
    }) }
]];
