/* O caminho de sucesso do serviço corresponde ao aceite HTTP 200/202 da
 * revalidação. Estados do veículo podem permanecer idênticos por horas; por
 * isso, a ausência de mudança no timestamp semântico não transforma esse
 * aceite em falha. */
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
const failureWasNotified = Number(state.failure_notified_at ?? 0) > 0;
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
}
state.recovery_notification_pending =
    state.recovery_notification_pending === true || failureWasNotified;
state.next_allowed_at = Math.max(
    Number(state.next_allowed_at ?? 0),
    now + intervalMs
);
state.attempts = 0;
state.awaiting_evidence = false;
state.evidence_wait_started_at = null;
state.last_success_at = now;
state.last_success_reason = "api_accepted_200_or_202";
state.last_evidence_domains = ["api"];
state.failure_notified_at = null;
state.failure_notification_key = null;
state.last_failure_class = null;
state.failure_at = null;
state.failure_source = null;
state.failure_endpoint = null;
state.failure_stage = null;
state.cache_probe_in_flight = false;
state.cache_probe_in_flight_until = null;
state.cache_probe_for_request_at = null;
state.cache_probe_completed_for_request_at = null;
state.cache_probe_settle_until = null;
state.state = "cooldown";
state.reason = "api_accepted_200_or_202";
state.next_retry_at = null;
state.cooldown_until = state.next_allowed_at;
state.updated_at = now;
flow.set(key, state, "persistent");
node.status({
    fill: "green",
    shape: "dot",
    text: "API respondeu 200/202; estado conhecido preservado"
});
return msg;
