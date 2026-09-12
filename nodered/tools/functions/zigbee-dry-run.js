const record = {
    simulated: true,
    dispatched: false,
    boundary: msg.topic ? "mqtt" : "notification",
    event: msg.zigbee_event || msg.zigbee_component_event || "publication",
    at: new Date(msg.zigbee_now || Date.now()).toISOString()
};
flow.set("zigbee_last_dry_run_v1__test", record);
node.status({ fill: "blue", shape: "dot", text: "TESTE: efeito bloqueado" });
return null;
