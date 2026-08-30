const source = String(msg.error?.source?.name ?? "unknown")
    .replace(/[^a-zA-Z0-9 _-]/g, "");
const message = String(msg.error?.message ?? "unknown")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240);
const failureClass = /(?:401|unauthori[sz]ed|authentic)/i.test(message)
    ? "authentication"
    : /(?:timeout|timed out|readtimeout)/i.test(message)
        ? "timeout"
        : /already in progress|coalesced/i.test(message)
            ? "concurrent_request_coalesced"
            : "api_error";
const key = "security_vehicle_primary_refresh_v1";
const state = flow.get(key, "persistent") ?? {};
const now = Date.now();
state.request_in_flight = false;
state.in_flight_until = null;
state.awaiting_evidence = true;
state.state = "backoff";
state.reason = failureClass;
state.failure_at = now;
state.failure_source = source;
state.last_failure_class = failureClass;
state.next_retry_at = Number(state.next_allowed_at ?? 0) || null;
state.cooldown_until = null;
state.updated_at = now;
flow.set(key, state, "persistent");
node.error(
    "VEHICLE_PRIMARY_API_ERROR class=" + failureClass +
    " source=" + source + " message=" + message
);
return null;
