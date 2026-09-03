const source = String(msg.error?.source?.name ?? "unknown")
    .replace(/[^\p{L}\p{N} _-]/gu, "");
const message = String(msg.error?.message ?? "unknown")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240);
const failureClass = /service\s+kia_uvo\.update\s+not\s+found/i.test(message)
    ? "integration_unavailable"
    : /provider denied|backoff is active|\b403\b.*\bForbidden\b/i.test(message)
    ? "provider_backoff"
    : /(?:401|unauthori[sz]ed|authentic)/i.test(message)
    ? "authentication"
    : /(?:timeout|timed out|readtimeout)/i.test(message)
        ? "timeout"
        : /already in progress|coalesced/i.test(message)
            ? "concurrent_request_coalesced"
            : "api_error";
const key = "security_vehicle_primary_refresh_v1";
const state = flow.get(key, "persistent") ?? {};
const now = Date.now();
const cacheProbeFailure = /cache|reler/i.test(source);
const failedEndpoint = cacheProbeFailure
    ? "kia_uvo.update (releitura do cache)"
    : "public_bindings.call (wake do veículo)";
const failureNotificationKey = `${failureClass}|${failedEndpoint}`;
const failureLabels = {
    authentication: "autenticação",
    timeout: "tempo esgotado",
    concurrent_request_coalesced: "requisição concorrente",
    provider_backoff: "acesso temporariamente recusado pelo provedor",
    api_error: "erro da API"
};
const intervalMs = [15 * 60 * 1000, 30 * 60 * 1000]
    .includes(Number(state.interval_ms))
        ? Number(state.interval_ms)
        : 15 * 60 * 1000;
state.request_in_flight = false;
state.in_flight_until = null;
state.cache_probe_in_flight = false;
state.cache_probe_in_flight_until = null;
state.cache_probe_for_request_at = null;
state.cache_probe_settle_until = null;
state.awaiting_evidence = true;
state.state = "backoff";
state.reason = failureClass;
state.failure_at = now;
state.failure_source = source;
state.failure_endpoint = failedEndpoint;
state.failure_stage = source;
state.last_failure_class = failureClass;
if (cacheProbeFailure) {
    state.next_allowed_at = Math.max(
        Number(state.next_allowed_at ?? 0),
        now + intervalMs
    );
}
state.next_retry_at = Number(state.next_allowed_at ?? 0) || null;
state.cooldown_until = null;
state.updated_at = now;
let notification = null;
if (
    state.failure_notification_key !== failureNotificationKey
) {
    state.failure_notified_at = now;
    state.failure_notification_key = failureNotificationKey;
    msg.payload = {
        ...(msg.payload ?? {}),
        test_mode: false,
        side_effect: "notify:resident_primary+persistent_notification"
    };
    msg.alert = failureClass === "integration_unavailable"
        ? {
            title: "Endpoint Bluelink indisponível",
            message:
                `O endpoint ${failedEndpoint} não está disponível no ` +
                "Home Assistant. A etapa que falhou foi “" + source +
                "”. As retentativas automáticas permanecem em backoff."
        }
        : {
            title: "Erro ao atualizar veículo",
            message:
                `Falha de ${failureLabels[failureClass] ?? failureClass} ` +
                `no endpoint ${failedEndpoint}, ` +
                `durante “${source}”. As retentativas automáticas ` +
                "permanecem em backoff."
        };
    msg.notification = {
        id: "vehicle_primary_refresh_failed",
        title: msg.alert.title,
        message: msg.alert.message
    };
    notification = msg;
}
flow.set(key, state, "persistent");
node.error(
    "VEHICLE_PRIMARY_API_ERROR class=" + failureClass +
    " source=" + source + " message=" + message
);
return notification;
