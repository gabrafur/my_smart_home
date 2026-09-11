/* O retorno do serviço confirma somente que o Home Assistant aceitou a
 * solicitação. Sucesso real exige que o timestamp semântico do veículo avance
 * no normalizador; até lá, preserve falhas e o bypass de segurança. */
const key = "security_vehicle_primary_refresh_v1";
const state = flow.get(key, "persistent") ?? {};
const now = Date.now();
const intervalMs = Number(state.interval_ms);
const intervalReady = Number.isFinite(intervalMs) && intervalMs > 0;
const requestAt = Number(state.last_request_at ?? state.last_attempt_at ?? now);
state.request_in_flight = false;
state.in_flight_until = null;
state.service_accepted_at = now;
state.next_allowed_at = intervalReady
    ? Math.max(Number(state.next_allowed_at ?? 0), requestAt + intervalMs)
    : Math.max(Number(state.next_allowed_at ?? 0), now);
state.awaiting_evidence = true;
state.evidence_wait_started_at = Number(state.evidence_wait_started_at) > 0
    ? state.evidence_wait_started_at
    : requestAt;
state.cache_probe_in_flight = false;
state.cache_probe_in_flight_until = null;
state.cache_probe_for_request_at = null;
state.cache_probe_completed_for_request_at = null;
state.cache_probe_settle_until = null;
state.state = "awaiting_evidence";
state.reason = "api_accepted_awaiting_fresh_data";
state.next_retry_at = state.next_allowed_at;
state.cooldown_until = null;
state.updated_at = now;
flow.set(key, state, "persistent");
node.status({
    fill: "yellow",
    shape: "ring",
    text: "serviço aceito; aguardando telemetria nova"
});
return msg;
