/* A chamada apenas solicita que o Home Assistant republique o cache atual.
 * A evidência semântica continua sendo avaliada pelo normalizador após o
 * pequeno prazo de propagação. */
const key = "security_vehicle_primary_refresh_v1";
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
const probeForRequestAt = Number(state.cache_probe_for_request_at ?? 0);
state.cache_probe_in_flight = false;
state.cache_probe_in_flight_until = null;
state.cache_probe_completed_for_request_at = probeForRequestAt || null;
state.cache_probe_for_request_at = null;
state.cache_probe_accepted_at = now;
state.cache_probe_settle_until = now + 15 * 1000;
state.engine_communication_failed = false;
if (apiFailureWasActive) {
    state.engine_bypass_recovery_pending = true;
    state.recovery_notification_pending =
        Number(state.failure_notified_at ?? 0) > 0;
}
state.state = "probing_cache";
state.reason = "cache_probe_accepted";
state.next_retry_at = Number(state.next_allowed_at ?? 0) || null;
state.cooldown_until = null;
state.updated_at = now;
flow.set(key, state, "persistent");
node.status({
    fill: "yellow",
    shape: "ring",
    text: "API respondeu ao cache; aguardando evidência"
});
return msg;
