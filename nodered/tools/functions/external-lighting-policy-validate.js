const DEFAULTS = { confirmation_settle_seconds: 5, confirmation_window_seconds: 60, recovery_ttl_hours: 12 };
const LIMITS = { confirmation_settle_seconds: [1, 30], confirmation_window_seconds: [2, 300], recovery_ttl_hours: [1, 24] };
const parameter = String(msg.topic ?? "");
const value = Number(msg.payload);
const bounds = LIMITS[parameter];
if (!bounds || !Number.isInteger(value) || value < bounds[0] || value > bounds[1]) {
    msg.external_policy_rejection = { parameter, value: msg.payload, bounds, preserved: true };
    return [null, msg];
}
const previous = global.get("external_lighting_policy_v1", "persistent");
const candidate = { ...DEFAULTS,
    ...(previous?.version === 1 && previous?.complete === true ? previous : {}),
    [parameter]: value, version: 1, owner: "node_red", complete: true, updated_at: Date.now() };
if (!Object.entries(LIMITS).every(([key, range]) => Number.isInteger(candidate[key]) &&
    candidate[key] >= range[0] && candidate[key] <= range[1]) ||
    candidate.confirmation_window_seconds <= candidate.confirmation_settle_seconds) {
    msg.external_policy_rejection = { parameter, value: msg.payload, bounds,
        reason: 'confirmation_window_must_exceed_settle', preserved: true };
    return [null, msg];
}
msg.external_policy_candidate = candidate;
return [msg, null];
