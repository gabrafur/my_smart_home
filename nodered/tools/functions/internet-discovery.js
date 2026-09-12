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
    {
        topic: "homeassistant/binary_sensor/internet_connection/config",
        payload: JSON.stringify({
            name: "Conexão com a internet",
            object_id: "internet_connection",
            default_entity_id: "binary_sensor.internet_connection",
            unique_id: "node_red_internet_connection",
            device_class: "connectivity",
            state_topic: "nodered/infrastructure/internet/connection",
            json_attributes_topic: "nodered/infrastructure/internet/attributes",
            payload_on: "ON",
            payload_off: "OFF",
            ...availability,
            device
        })
    },
    {
        topic: "homeassistant/sensor/internet_connection_state/config",
        payload: JSON.stringify({
            name: "Estado da conexão com a internet",
            object_id: "internet_connection_state",
            default_entity_id: "sensor.internet_connection_state",
            unique_id: "node_red_internet_connection_state",
            icon: "mdi:wan",
            entity_category: "diagnostic",
            state_topic: "nodered/infrastructure/internet/state",
            json_attributes_topic: "nodered/infrastructure/internet/attributes",
            ...availability,
            device
        })
    }
]];
