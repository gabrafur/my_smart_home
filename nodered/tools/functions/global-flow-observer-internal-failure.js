const STATE_KEY = "global_flow_observer_internal_failure_v1";
const STORE = "persistent";
const now = Date.now();
const source = msg.error?.source ?? {};
const sourceId = String(source.id ?? "unknown").slice(0, 100);
const sourceName = String(source.name || source.type || "nó desconhecido")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 100);
const errorMessage = String(msg.error?.message ?? "erro desconhecido")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240);
const signature = `${sourceId}:${errorMessage}`;
const previous = flow.get(STATE_KEY, STORE) ?? {};

if (
    previous.signature === signature &&
    now - Number(previous.notified_at ?? 0) < 6 * 60 * 60 * 1000
) {
    return [null, null];
}

flow.set(STATE_KEY, { signature, notified_at: now }, STORE);
msg.payload = {
    observer_kind: "monitor_internal_error",
    source_id: sourceId
};
msg.alert = {
    title: "Falha no monitor global do Node-RED",
    message:
        `O próprio monitor de observabilidade falhou no nó “${sourceName}”: ` +
        `${errorMessage}. Incidentes idênticos serão silenciados por 6 horas.`
};
msg._observer_persistent_notification_id =
    `nodered_observabilidade_global_monitor_internal_error_${sourceId}`
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .slice(0, 255);

return [msg, msg];
