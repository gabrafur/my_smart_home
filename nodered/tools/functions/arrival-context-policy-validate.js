const candidate = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const inflight = Number(candidate.inflight_timeout_s);
const future = Number(candidate.future_tolerance_s);
const homeDelay = Number(candidate.home_confirmation_delay_s);
const homeRetry = Number(candidate.home_confirmation_retry_s);
const homeExpiry = Number(candidate.home_confirmation_expiry_min);
const errors = [];
if (!Number.isInteger(inflight) || inflight < 1 || inflight > 60) errors.push("inflight_timeout_s");
if (!Number.isInteger(future) || future < 0 || future > 300) errors.push("future_tolerance_s");
if (!Number.isInteger(homeDelay) || homeDelay < 30 || homeDelay > 300) errors.push("home_confirmation_delay_s");
if (!Number.isInteger(homeRetry) || homeRetry < 10 || homeRetry > 120) errors.push("home_confirmation_retry_s");
if (!Number.isInteger(homeExpiry) || homeExpiry < 5 || homeExpiry > 60) errors.push("home_confirmation_expiry_min");
msg.policy_valid = errors.length === 0;
msg.policy_error = errors.join(",");
msg.policy_candidate = msg.policy_valid ? {
    version: 1, inflight_timeout_s: inflight, future_tolerance_s: future,
    home_confirmation_delay_s: homeDelay,
    home_confirmation_retry_s: homeRetry,
    home_confirmation_expiry_min: homeExpiry
} : null;
return msg;
