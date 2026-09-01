const TEST_MODE =
    msg._global_observer_test === true ||
    msg.payload?.test_mode === true;
const DELIVERY_TEST = msg._observer_delivery_test === true;

if (TEST_MODE && !DELIVERY_TEST) return [null, null, msg];

if (DELIVERY_TEST) {
    msg.payload = {
        ...(msg.payload ?? {}),
        test_mode: true,
        notification_delivery_under_test: true
    };
    msg.alert = {
        title: "TESTE — Monitor global do Node-RED",
        message:
            "TESTE de entrega: o canal central de falhas dos fluxos " +
            "Node-RED conseguiu solicitar esta notificação ao Home Assistant."
    };
    return [msg, null, null];
}

const kind = String(msg.payload?.observer_kind ?? "unknown");
const incident = String(
    msg.payload?.incident_key ??
    (
        [msg.payload?.flow_id, msg.payload?.source_id]
            .filter(Boolean)
            .join("_") ||
        "unknown"
    )
);
msg._observer_persistent_notification_id =
    `nodered_observabilidade_global_${kind}_${incident}`
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .slice(0, 255);

return [msg, msg, null];
