const s = msg.storage;
let alert = null;
if (s.error_due) {
    alert = {
        payload: { title: "Raspberry Pi - storage indisponivel", message: "Falha ao obter metricas validas de armazenamento do Home Assistant. Nenhuma manutencao foi executada." },
        notificationAck: { id: `${s.now}:lastErrorNotificationAt`, at: s.now, targets: [{ key: "storage_health_state_v1", field: "lastErrorNotificationAt" }] }
    };
    s.state.pendingAlert = alert;
}
flow.set("storage_health_state_v1", s.state, "persistent");
const mqtt = [{ topic: "smart_home/raspberry/storage/health_last_run", payload: new Date(s.now).toISOString(), retain: true }];
const event = { ...msg, payload: { event: "invalid_metrics", at: new Date(s.now).toISOString(), input: s.input } };
return [msg.test_mode === true ? [] : mqtt, msg.test_mode === true ? null : alert, event, null];
