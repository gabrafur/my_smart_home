// Serialize a bounded, numeric contract. Final test/production gate is downstream.
const topic = "local_ai/rtx_metrics/state";
const definitions = [
    ["painel", "RTX Painel", null, "mdi:expansion-card"],
    ["gpu", "RTX Metricas GPU", "%", "mdi:chip"],
    ["vram", "RTX Metricas VRAM", "MiB", "mdi:memory"],
    ["power", "RTX Metricas Potencia", "W", "mdi:lightning-bolt"],
    ["net_today", "RTX Contexto Evitado Hoje", "tokens", "mdi:arrow-collapse-horizontal"],
    ["calls_today", "RTX Tentativas Hoje", "tentativas", "mdi:counter"],
    ["used_today", "RTX Uso Confirmado Hoje", "resultados", "mdi:check-decagram"],
    ["reduction_today", "RTX Reducao Hoje", "%", "mdi:percent"],
    ["use_rate_today", "RTX Aproveitamento Hoje", "%", "mdi:chart-donut"],
    ["net_total", "RTX Contexto Evitado Total", "tokens", "mdi:sigma"],
];
const output = definitions.map(([key, name, unit, icon]) => {
    const config = { name, unique_id: `rtx_metrics_${key}`, state_topic: topic, expire_after: 45, icon,
        default_entity_id: `sensor.${name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replaceAll(" ", "_")}`,
        availability_topic: "nodered/status", payload_available: "online", payload_not_available: "offline",
        value_template: key === "painel" ? "{{ value_json.health.label }}" : `{{ value_json.metrics.${key} if value_json.metrics.${key} is not none else 'None' }}`,
        device: { identifiers: ["rtx_metrics_nodered"], name: "RTX · métricas Node-RED", manufacturer: "Local AI", model: "Observabilidade" },
    };
    if (unit) Object.assign(config, { unit_of_measurement: unit, state_class: "measurement" });
    if (key === "power") config.device_class = "power";
    if (key === "painel") config.json_attributes_topic = topic;
    return { topic: `homeassistant/sensor/rtx_metrics/${key}/config`, payload: JSON.stringify(config), qos: "1", retain: true, test_mode: msg.test_mode === true };
});
// Discovery is retained and refreshed each minute, including after HA reconnects.
const key = msg.test_mode === true ? "rtx_metrics_test_discovery" : "rtx_metrics_discovery";
const last = context.get(key) || 0;
const messages = msg.rtx.now - last >= 60000 ? output : [];
if (messages.length) context.set(key, msg.rtx.now);
const report = { ...msg.report, jobs: [...msg.report.jobs], history_truncated: false };
while (Buffer.byteLength(JSON.stringify(report), "utf8") > 12000 && report.jobs.length) {
    report.jobs.pop(); report.history_truncated = true;
}
messages.push({ topic, payload: JSON.stringify(report), qos: "0", retain: true, test_mode: msg.test_mode === true });
return [messages];
