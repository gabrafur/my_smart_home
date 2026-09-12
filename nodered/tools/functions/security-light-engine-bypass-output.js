const data = msg._engine_bypass;
if (data.previous_enabled !== data.enabled || data.branch === "startup") {
    node.status({ fill: data.enabled ? "yellow" : "grey", shape: data.enabled ? "dot" : "ring",
        text: data.enabled ? (data.automatic ? "bypass automático: API indisponível" :
            "bypass manual do motor ATIVO") : "bypass manual do motor desligado" });
}
if (!data.test_mode && data.previous_enabled !== data.enabled) {
    if (data.enabled) node.warn("iluminacao_seguranca: bypass do motor ativado" +
        (data.automatic ? " automaticamente pela indisponibilidade da API; " : "; ") +
        "só será aplicado enquanto a telemetria do motor estiver não confiável");
    else node.log?.("iluminacao_seguranca: bypass manual do motor desativado");
}
const reevaluate = { payload: { contract: "security.engine-bypass.v1", kind: "engine_bypass_context",
    source: data.test_mode ? "manual_test" : data.source, enabled: data.enabled,
    automatic: data.automatic, communication_failed: data.communication_failed,
    updated_at: Date.now(), test_mode: data.test_mode } };
if (data.test_mode) {
    reevaluate._location_test = true;
    reevaluate._location_test_case = msg._location_test_case ?? msg.payload?.test_case ?? "engine_bypass";
    reevaluate.payload.test_case = reevaluate._location_test_case;
    return [null, reevaluate];
}
const discovery = { topic: "homeassistant/switch/vehicle_primary_engine_bypass/config", retain: true, qos: 1,
    payload: JSON.stringify({ name: "Bypass do motor para iluminação de chegada",
        unique_id: "vehicle_primary_engine_bypass", object_id: "vehicle_primary_engine_bypass",
        state_topic: "homeassistant/vehicle_primary/engine_bypass/state",
        command_topic: "homeassistant/vehicle_primary/engine_bypass/set", payload_on: "ON", payload_off: "OFF",
        state_on: "ON", state_off: "OFF", icon: "mdi:car-light-alert",
        device: { identifiers: ["vehicle_primary_bluelink"], name: "vehicle_primary", manufacturer: "Hyundai" } }) };
const state = { topic: "homeassistant/vehicle_primary/engine_bypass/state", retain: true, qos: 1,
    payload: data.enabled ? "ON" : "OFF" };
return [[discovery, state], reevaluate];
