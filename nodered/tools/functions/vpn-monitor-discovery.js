const availability = {
    availability_topic: "nodered/status",
    payload_available: "online",
    payload_not_available: "offline"
};
const device = {
    identifiers: ["node_red_vpn_monitoring"],
    name: "Monitoramento de VPN",
    manufacturer: "Node-RED",
    model: "Disponibilidade de túneis privados"
};
return [[
    {
        topic: "homeassistant/binary_sensor/vpn_primary_connection/config",
        payload: JSON.stringify({
            name: "Conexão VPN principal",
            object_id: "vpn_primary_connection",
            default_entity_id: "binary_sensor.vpn_primary_connection",
            unique_id: "node_red_vpn_primary_connection",
            device_class: "connectivity",
            state_topic: "nodered/infrastructure/vpn/vpn_primary/connection",
            json_attributes_topic: "nodered/infrastructure/vpn/vpn_primary/attributes",
            payload_on: "ON",
            payload_off: "OFF",
            ...availability,
            device
        })
    },
    {
        topic: "homeassistant/sensor/vpn_primary_connection_state/config",
        payload: JSON.stringify({
            name: "Estado da VPN principal",
            object_id: "vpn_primary_connection_state",
            default_entity_id: "sensor.vpn_primary_connection_state",
            unique_id: "node_red_vpn_primary_connection_state",
            icon: "mdi:vpn",
            entity_category: "diagnostic",
            state_topic: "nodered/infrastructure/vpn/vpn_primary/state",
            json_attributes_topic: "nodered/infrastructure/vpn/vpn_primary/attributes",
            ...availability,
            device
        })
    }
]];
