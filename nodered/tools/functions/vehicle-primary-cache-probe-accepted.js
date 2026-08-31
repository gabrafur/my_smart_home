/* A chamada apenas solicita que o Home Assistant republique o cache atual.
 * A evidência semântica continua sendo avaliada pelo normalizador após o
 * pequeno prazo de propagação. */
const key = "security_vehicle_primary_refresh_v1";
const state = flow.get(key, "persistent") ?? {};
const now = Date.now();
const probeForRequestAt = Number(state.cache_probe_for_request_at ?? 0);
state.cache_probe_in_flight = false;
state.cache_probe_in_flight_until = null;
state.cache_probe_completed_for_request_at = probeForRequestAt || null;
state.cache_probe_for_request_at = null;
state.cache_probe_accepted_at = now;
state.cache_probe_settle_until = now + 15 * 1000;
state.state = "probing_cache";
state.reason = "cache_probe_accepted";
state.next_retry_at = Number(state.next_allowed_at ?? 0) || null;
state.cooldown_until = null;
state.updated_at = now;
flow.set(key, state, "persistent");
node.status({
    fill: "yellow",
    shape: "ring",
    text: "cache relido; aguardando evidência"
});
return msg;
