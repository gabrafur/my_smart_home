/* O retorno do serviço prova apenas aceitação da chamada pelo Home Assistant.
 * Sucesso depende de timestamps novos nas entidades e é confirmado pelo
 * normalizador após a rechecagem. */
const key = "security_vehicle_primary_refresh_v1";
const AWAY_INTERVAL_MS = 15 * 60 * 1000;
const HOME_INTERVAL_MS = 30 * 60 * 1000;
const state = flow.get(key, "persistent") ?? {};
const now = Date.now();
const API_FAILURE_CLASSES = new Set([
    "integration_unavailable",
    "provider_backoff",
    "authentication",
    "timeout",
    "api_error"
]);
const apiFailureWasActive =
    state.engine_communication_failed === true ||
    API_FAILURE_CLASSES.has(state.last_failure_class);
const intervalMs = [AWAY_INTERVAL_MS, HOME_INTERVAL_MS]
    .includes(Number(state.interval_ms))
        ? Number(state.interval_ms)
        : AWAY_INTERVAL_MS;
state.request_in_flight = false;
state.in_flight_until = null;
state.service_accepted_at = now;
state.engine_communication_failed = false;
if (apiFailureWasActive) {
    state.engine_bypass_recovery_pending = true;
    state.recovery_notification_pending =
        Number(state.failure_notified_at ?? 0) > 0;
}
state.next_allowed_at = Math.max(
    Number(state.next_allowed_at ?? 0),
    now + intervalMs
);
state.state = "awaiting_evidence";
state.reason = state.recovery_reason ?? "service_accepted_awaiting_evidence";
state.next_retry_at = Number(state.next_allowed_at ?? 0) || null;
state.cooldown_until = null;
state.updated_at = now;
flow.set(key, state, "persistent");
node.status({
    fill: "yellow",
    shape: "ring",
    text: "API respondeu; aguardando evidência nova"
});
return msg;
