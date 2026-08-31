const source = String(msg.error?.source?.name ?? "unknown")
    .replace(/[^a-zA-Z0-9 _-]/g, "");
const message = String(msg.error?.message ?? "unknown")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240);
const failureClass = /service\s+kia_uvo\.update\s+not\s+found/i.test(message)
    ? "integration_unavailable"
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
if (!Number.isFinite(state.failure_notified_at)) {
    state.failure_notified_at = now;
    msg.payload = {
        ...(msg.payload ?? {}),
        test_mode: false,
        side_effect: "notify:resident_primary"
    };
    msg.alert = {
        title: "Erro ao atualizar veículo",
        message:
            "A atualização do veículo falhou antes de receber novos dados. " +
            "As retentativas automáticas permanecem em backoff; verifique " +
            "a integração Bluelink."
    };
    notification = msg;
}
flow.set(key, state, "persistent");
node.error(
    "VEHICLE_PRIMARY_API_ERROR class=" + failureClass +
    " source=" + source + " message=" + message
);
return notification;
