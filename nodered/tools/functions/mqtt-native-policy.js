const test = msg.test_mode === true;
const store = test ? "memoryOnly" : "persistent";
const key = "mqtt_native_policy_v1" + (test ? "__test" : "");
const previous = flow.get(key, store);
if (msg._mqtt_defaults === true && previous && typeof previous.enabled === "boolean"
    && Number.isInteger(previous.event_latency_ms) && previous.event_latency_ms >= 1000 && previous.event_latency_ms <= 60000) return null;
const p = msg.payload;
if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).length !== 2
    || typeof p.enabled !== "boolean" || !Number.isInteger(p.event_latency_ms)
    || p.event_latency_ms < 1000 || p.event_latency_ms > 60000) {
    node.status({fill:"yellow",shape:"ring",text:"parâmetro inválido; anterior preservado"});
    return null;
}
flow.set(key, {...p}, store);
node.status({fill:"green",shape:"dot",text:"parâmetros guardados"});
return msg._mqtt_test_source === true ? msg : null;
