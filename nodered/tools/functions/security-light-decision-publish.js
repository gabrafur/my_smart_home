const TEST_MODE = msg._location_test === true || msg.payload?.test_mode === true;
if (TEST_MODE) return null;

const stateTopic = "smart_home/security_light/last_decision/state";
const attributesTopic = "smart_home/security_light/last_decision/attributes";
if (msg.topic === "security_light_decision_discovery") {
    return [[{
        topic: "homeassistant/sensor/security_light_last_decision/config",
        qos: "1",
        retain: true,
        payload: JSON.stringify({
            name: "Iluminação de segurança — última decisão",
            unique_id: "security_light_last_decision",
            object_id: "security_light_last_decision",
            default_entity_id: "sensor.security_light_last_decision",
            state_topic: stateTopic,
            json_attributes_topic: attributesTopic,
            icon: "mdi:shield-home-outline",
            entity_category: "diagnostic"
        })
    }]];
}

let decision = msg._security_light_decision_state;
const payload = msg.payload ?? {};
if (!decision && payload.kind === "arrival_blocked") decision = "blocked_direction";
if (!decision && payload.diagnostic === "arrival_trigger_received") {
    if (payload.sun_ready !== true || payload.sun_below_horizon !== true) {
        decision = "blocked_daylight";
    } else if (payload.vehicle_primary_engine_state_valid === true &&
        payload.vehicle_primary_engine_on === false &&
        payload.engine_communication_failed !== true) {
        decision = "blocked_engine_off";
    } else if (payload.reflector_state === "on") {
        decision = "blocked_reflector_on";
    } else if (payload.decision_context_ready !== true) {
        decision = "waiting_context";
    } else {
        decision = "evaluating";
    }
}
if (!decision) return null;

const now = Date.now();
const source = ["resident_primary", "resident_secondary"].includes(payload.source)
    ? payload.source : null;
flow.set("security_light_last_decision_v1", {
    version: 1, decision, source, reason: payload.reason ?? payload.direction_reason ?? null,
    updated_at: now
}, "persistent");
return [[
    { topic: stateTopic, qos: "1", retain: true, payload: decision },
    { topic: attributesTopic, qos: "1", retain: true, payload: JSON.stringify({
        decision, source,
        reason: payload.reason ?? payload.direction_reason ?? null,
        attempt: Number.isFinite(Number(payload.attempt)) ? Number(payload.attempt) : null,
        updated_at: new Date(now).toISOString()
    }) }
]];
