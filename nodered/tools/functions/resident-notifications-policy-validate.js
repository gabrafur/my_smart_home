const input = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const bounds = {
    dedupe_ttl_ms: [60000, 3600000],
    max_event_age_ms: [60000, 3600000],
    future_tolerance_ms: [0, 300000],
    service_retry_seconds: [10, 600],
    home_confirmation_seconds: [30, 300],
    home_confirmation_window_seconds: [90, 900],
    home_confirmation_recheck_seconds: [10, 60]
};
const values = {};
const errors = [];
for (const [field, limits] of Object.entries(bounds)) {
    const value = Number(input[field]);
    values[field] = value;
    if (!Number.isInteger(value) || value < limits[0] || value > limits[1]) {
        errors.push(field);
    }
}
if (values.future_tolerance_ms >= values.max_event_age_ms) {
    errors.push("future_tolerance_lt_max_age");
}
if (values.home_confirmation_window_seconds < values.home_confirmation_seconds) {
    errors.push("home_window_gte_confirmation");
}
if (values.home_confirmation_recheck_seconds >= values.home_confirmation_seconds) {
    errors.push("home_recheck_lt_confirmation");
}
msg.policy_valid = errors.length === 0;
msg.policy_error = errors.join(",");
msg.policy_candidate = msg.policy_valid ? { version: 3, ...values } : null;
return msg;
