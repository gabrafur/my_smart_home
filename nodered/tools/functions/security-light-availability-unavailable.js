const data = msg._light_availability;
const suffix = data.test_mode ? "__test" : "";
const set = (name, value, store) => data.test_mode || !store
    ? flow.set(name + suffix, value) : flow.set(name, value, store);
let reason = "estado físico não reconciliado";
if (data.physical === "unavailable") reason = "entidade Zigbee unavailable";
else if (data.physical === "unknown") reason = "entidade Zigbee unknown";
else if (!data.physical_fresh) reason = "estado físico do refletor está stale";
set("security_light_turn_on_notification_latch_v1", {
    version: 1, latched: true, reason: "would_turn_on_actuator_unavailable",
    latched_at: data.now, arrival_key: msg.payload?.arrival_key ?? null,
    reflector_state: data.physical
}, "persistent");
flow.set("security_light_unavailable_decision_v1", {
    key: data.decision_key, at: data.now, state: data.physical
});
Object.assign(msg.payload, {
    actuator_available: false, would_turn_on: true,
    reflector_state: data.physical, reflector_error: reason,
    message: `${data.test_mode ? "[TESTE] " : ""}Erro no refletor da garagem: ${reason}. ` +
        "Os triggers e as condições foram satisfeitos; o refletor SERIA LIGADO, " +
        "mas o comando não foi enviado porque o atuador não está disponível."
});
data.output = data.test_mode ? 2 : 1;
return msg;
