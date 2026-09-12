const testMode = msg._tuya_test === true;
const key = testMode ? "tuya_device_monitor_summary_v1__test" : "tuya_device_monitor_summary_v1";
const summary = testMode ? (flow.get(key) || {}) : (flow.get(key, "persistent") || {});
const now = Number(msg.monitor_now ?? Date.now());
const error = String(msg.error?.message || msg.error || msg.tuya_snapshot_error || "consulta indisponível")
    .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
msg.tuya_phase = "checking";
msg.tuya_publications = [
    { topic: "nodered/infrastructure/tuya/connection", payload: "OFF" },
    { topic: "nodered/infrastructure/tuya/attributes", payload: JSON.stringify({
        state: "checking", checked_at: new Date(now).toISOString(),
        last_success: summary.last_success_at || "Nenhuma consulta concluída", error
    }) },
    { topic: "nodered/infrastructure/tuya/state", payload: "checking" }
];
return msg;
