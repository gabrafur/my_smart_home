for (const key of [
    "zigbee_bridge_observation__test",
    "zigbee_network_monitor_state_v1__test",
    "zigbee_network_monitor_history_v1__test",
    "zigbee_component_incidents_v1__test",
    "zigbee_route_incidents_v1__test",
    "zigbee_route_pending__test", "zigbee_route_live__test", "zigbee_boot_at__test",
    "zigbee_component_observations__test",
    "zigbee_last_dry_run_v1__test"
]) flow.set(key, undefined);
node.status({ fill: "blue", shape: "dot", text: "estado TESTE resetado" });
return null;
