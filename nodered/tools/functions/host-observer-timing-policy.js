const value = msg.payload;
if (!value || Object.keys(value).length !== 2 ||
    !Number.isFinite(value.event_latency_ms) || value.event_latency_ms < 1000 || value.event_latency_ms > 60000 ||
    !Number.isFinite(value.resource_latency_ms) || value.resource_latency_ms < 20000 || value.resource_latency_ms > 120000) {
    node.status({fill: "yellow", shape: "ring", text: "contrato inválido; anterior preservado"});
    return null;
}
flow.set("host_observer_timing_policy_v1", {...value}, "persistent");
node.status({fill: "green", shape: "dot", text: "contrato de medição publicado"});
return null;
