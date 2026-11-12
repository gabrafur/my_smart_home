const s = msg.storage;
let alert = null;
if (s.error_due) {
    alert = s.state.pendingAlert?.collection_error ? s.state.pendingAlert : {
        collection_error: true,
        payload: { title: "Raspberry Pi - falha na leitura do storage", message: `Não foi possível obter métricas válidas após ${msg.policy.collection_max_retries} novas tentativas. Isso não confirma defeito nem falta de espaço no disco. A coleta periódica continuará; nenhuma limpeza foi solicitada por esta falha.` },
        notificationAck: { id: `${s.now}:collection_error`, at: s.now, targets: [{ key: s.stateKey, field: "lastCollectionErrorNotificationAt" }] }
    };
    s.state.pendingAlert = alert;
    s.state.collectionIncidentOpen = true;
}
if (s.testMode) flow.set(s.stateKey, s.state); else flow.set(s.stateKey, s.state, "persistent");
const mqtt = [{ topic: "smart_home/raspberry/storage/collection_status", payload: s.state.collectionStatus, retain: true }];
const event = { ...msg, payload: { event: "collection_failure", reason: s.collection_reason,
    attempt: s.state.collectionFailureCount, retryScheduled: s.retry_due, at: new Date(s.now).toISOString() } };
return [s.testMode ? [] : mqtt, s.testMode ? null : alert, event, s.retry_due ? msg : null];
