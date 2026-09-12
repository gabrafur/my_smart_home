const candidate = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const dedupe = Number(candidate.dedupe_ttl_ms);
const maxAge = Number(candidate.max_event_age_ms);
const future = Number(candidate.future_tolerance_ms);
const retry = Number(candidate.service_retry_seconds);
const errors = [];

if (!Number.isInteger(dedupe) || dedupe < 60000 || dedupe > 3600000) errors.push("dedupe_ttl_ms");
if (!Number.isInteger(maxAge) || maxAge < 60000 || maxAge > 3600000) errors.push("max_event_age_ms");
if (!Number.isInteger(future) || future < 0 || future > 300000) errors.push("future_tolerance_ms");
if (!Number.isInteger(retry) || retry < 10 || retry > 600) errors.push("service_retry_seconds");
if (Number.isInteger(maxAge) && Number.isInteger(future) && future >= maxAge) errors.push("future_tolerance_lt_max_age");

msg.policy_valid = errors.length === 0;
msg.policy_error = errors.join(",");
msg.policy_candidate = msg.policy_valid ? {
    version: 2,
    dedupe_ttl_ms: dedupe,
    max_event_age_ms: maxAge,
    future_tolerance_ms: future,
    service_retry_seconds: retry
} : null;
return msg;
