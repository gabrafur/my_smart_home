const key = "security_vehicle_primary_refresh_v1";
const state = flow.get(key, "persistent") ?? {};
const entity = msg.payload ?? {};
const status = String(entity.attributes?.status ?? "unknown");
const retryAt = Date.parse(String(entity.state ?? ""));
const now = Date.now();
const active =
    status === "rate_limited" &&
    Number.isFinite(retryAt) &&
    retryAt > now;

if (active) {
    state.provider_retry_at = retryAt;
    state.next_allowed_at = Math.max(
        Number(state.next_allowed_at ?? 0),
        retryAt
    );
    state.next_retry_at = state.next_allowed_at;
    state.awaiting_evidence = true;
    state.request_in_flight = false;
    state.in_flight_until = null;
    state.cache_probe_in_flight = false;
    state.cache_probe_in_flight_until = null;
    state.cache_probe_for_request_at = null;
    state.cache_probe_settle_until = null;
    state.state = "backoff";
    state.reason = "provider_backoff";
    state.last_failure_class = "provider_backoff";
    state.updated_at = now;
    flow.set(key, state, "persistent");
    node.status({
        fill: "grey",
        shape: "ring",
        text: `provedor em backoff até ${new Date(retryAt).toISOString()}`
    });
    return {
        topic: "homeassistant/vehicle_primary/engine_bypass/set",
        qos: 1,
        retain: false,
        payload: JSON.stringify({
            requested_state: "ON",
            source: "provider_backoff"
        })
    };
}

const previousProviderRetryAt = Number(state.provider_retry_at ?? 0);
if (
    previousProviderRetryAt > 0 &&
    status === "available"
) {
    state.provider_retry_at = null;
    if (
        state.reason === "provider_backoff" &&
        Number(state.next_allowed_at ?? 0) <= previousProviderRetryAt
    ) {
        state.next_allowed_at = now;
        state.next_retry_at = now;
    }
    state.updated_at = now;
    flow.set(key, state, "persistent");
    node.status({ fill: "green", shape: "dot", text: "provedor liberado" });
    return {
        topic: "homeassistant/vehicle_primary/engine_bypass/set",
        qos: 1,
        retain: false,
        payload: JSON.stringify({
            requested_state: "OFF",
            source: "provider_recovered"
        })
    };
}

return null;
