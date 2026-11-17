// Carry only canonical timing fields; the receipt serializer validates them.
// Missing source clocks remain unknown, including legacy domain alerts.
const timingPayload = msg.payload ?? {};
msg._notification_timing = {
    version: 1,
    source_observed_at: timingPayload.source_observed_at ?? null,
    source_time_kind: timingPayload.source_time_kind ?? "unknown",
    first_detected_at: timingPayload.first_detected_at ?? null,
    policy_decided_at: timingPayload.policy_decided_at ?? null
};
const TEST_MODE =
    msg._global_observer_test === true ||
    msg.payload?.test_mode === true;
const DELIVERY_TEST = msg._observer_delivery_test === true;

if(msg._eva_private_delivery_test===true){
 if(msg.payload?.incident_key!=='delivery_test'||msg.payload?.notification_delivery_under_test!==true||msg.payload?.notification_audience!=='eva_private'||msg.payload?.owner_escalation===true)throw Error('private_delivery_test_scope');
 return [null,null,null,msg];
}

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
const persistentKind = String(
    msg.payload?.persistent_incident_kind ?? kind
);
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
    `nodered_observabilidade_global_${persistentKind}_${incident}`
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .slice(0, 255);

// Explicit audience from the canonical producer, never inferred from muted mobile.
if (msg.payload?.notification_audience === 'eva_private') {
    if (msg.payload?.owner_escalation === true) return [msg, msg, null, msg];
    // shadow_fallback=false: the producer's owner decided this incident has no HA copy
    // even before exclusive delivery (host observations are diagnostics for Eva only).
    if(msg._eva_policy?.delivery_mode!=='exclusive'&&msg.payload?.shadow_fallback!==false)return [null,msg,null,msg];
    return [null, null, null, msg];
}

if (msg.payload?.mobile_notification === false) {
    return [null, msg, null];
}

return [msg, msg, null];
