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
const tripRefreshFailure = /viagens?|trip/i.test(source);
const successfulHttpResponse = /\b(?:200|202)\b/.test(message);
if (successfulHttpResponse && !tripRefreshFailure) {
    const failureWasNotified = Number(state.failure_notified_at ?? 0) > 0;
    const apiFailureWasActive = state.engine_communication_failed === true;
    const intervalMs = [15 * 60 * 1000, 30 * 60 * 1000]
        .includes(Number(state.interval_ms))
            ? Number(state.interval_ms)
            : 15 * 60 * 1000;
    state.request_in_flight = false;
    state.in_flight_until = null;
    state.awaiting_evidence = false;
    state.evidence_wait_started_at = null;
    state.service_accepted_at = now;
    state.last_success_at = now;
    state.last_success_reason = "api_accepted_200_or_202";
    state.last_evidence_domains = ["api"];
    state.attempts = 0;
    state.engine_communication_failed = false;
    state.engine_bypass_recovery_pending =
        state.engine_bypass_recovery_pending === true || apiFailureWasActive;
    state.recovery_notification_pending =
        state.recovery_notification_pending === true || failureWasNotified;
    state.failure_notified_at = null;
    state.failure_notification_key = null;
    state.last_failure_class = null;
    state.failure_at = null;
    state.failure_source = null;
    state.failure_endpoint = null;
    state.failure_stage = null;
    state.next_allowed_at = Math.max(
        Number(state.next_allowed_at ?? 0),
        now + intervalMs
    );
    state.next_retry_at = null;
    state.cooldown_until = state.next_allowed_at;
    state.state = "cooldown";
    state.reason = "api_accepted_200_or_202";
    state.updated_at = now;
    flow.set(key, state, "persistent");
    node.warn(
        "VEHICLE_PRIMARY_API_ACCEPTED_FROM_ERROR_PATH" +
        " source=" + source + " message=" + message
    );
    return null;
}
const engineRelevantFailure =
    !tripRefreshFailure &&
    failureClass !== "concurrent_request_coalesced";
const shouldActivateAutomaticBypass =
    engineRelevantFailure &&
    state.engine_communication_failed !== true;
const failedEndpoint = tripRefreshFailure
    ? "public_bindings.call (viagens do dia)"
    : cacheProbeFailure
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
if (engineRelevantFailure) {
    state.engine_communication_failed = true;
    state.engine_bypass_recovery_pending = false;
} else if (typeof state.engine_communication_failed !== "boolean") {
    state.engine_communication_failed = false;
}
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
const bypassCommand = shouldActivateAutomaticBypass
    ? {
        topic: "homeassistant/vehicle_primary/engine_bypass/set",
        qos: 1,
        retain: false,
        payload: JSON.stringify({
            requested_state: "ON",
            source: "api_failure"
        })
    }
    : null;
const logMessage =
    "VEHICLE_PRIMARY_API_ERROR class=" + failureClass +
    " source=" + source + " message=" + message;
if (failureClass === "provider_backoff") {
    // A recusa 403 já foi convertida em backoff persistente e alerta
    // deduplicado. Ela é um estado esperado do provedor, não uma nova falha
    // de execução do canvas para o observador global voltar a notificar.
    node.warn(logMessage);
} else {
    node.error(logMessage);
}
return notification || bypassCommand
    ? [notification, bypassCommand]
    : null;
