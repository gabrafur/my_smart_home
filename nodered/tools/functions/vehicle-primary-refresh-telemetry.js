const raw = flow.get("security_vehicle_primary_refresh_v1", "persistent") ?? {};
const now = Date.now();
let state = raw.state ?? "idle";
let deadline = null;

if (
    raw.cache_probe_in_flight === true &&
    Number(raw.cache_probe_in_flight_until ?? 0) > now
) {
    deadline = Number(raw.cache_probe_in_flight_until);
    state = "probing_cache";
} else if (Number(raw.cache_probe_settle_until ?? 0) > now) {
    deadline = Number(raw.cache_probe_settle_until);
    state = "probing_cache";
} else if (
    raw.request_in_flight === true &&
    Number(raw.in_flight_until ?? 0) > now
) {
    deadline = Number(raw.in_flight_until);
    state = "in_flight";
} else if (raw.awaiting_evidence === true) {
    deadline = Number(raw.next_retry_at ?? raw.next_allowed_at ?? 0) || null;
    if (
        !["refreshing", "awaiting_evidence", "probing_cache"].includes(state) ||
        now - Number(raw.last_attempt_at ?? 0) >= 30 * 1000
    ) {
        state = "backoff";
    }
} else if (Number(raw.cooldown_until ?? raw.next_allowed_at ?? 0) > now) {
    deadline = Number(raw.cooldown_until ?? raw.next_allowed_at);
    state = "cooldown";
} else if (state === "cooldown") {
    state = "idle";
}

const remainingSeconds = deadline && deadline > now
    ? Math.max(0, Math.ceil((deadline - now) / 1000))
    : 0;
const iso = (value) => Number(value) > 0
    ? new Date(Number(value)).toISOString()
    : null;

const status = {
    state,
    reason: raw.reason ?? raw.recovery_reason ?? null,
    attempt: Number(raw.attempts ?? 0),
    last_request_at: iso(raw.last_request_at ?? raw.last_attempt_at),
    last_success_at: iso(raw.last_success_at),
    next_retry_at: raw.awaiting_evidence === true
        ? iso(raw.next_retry_at ?? raw.next_allowed_at)
        : null,
    cooldown_until: raw.awaiting_evidence !== true
        ? iso(raw.cooldown_until ?? raw.next_allowed_at)
        : null,
    remaining_seconds: remainingSeconds,
    awaiting_evidence: raw.awaiting_evidence === true,
    interval_minutes: Number(raw.interval_ms ?? 0) / 60_000 || null,
    interval_policy: raw.interval_policy ?? null,
    request_in_flight: raw.request_in_flight === true,
    in_flight_until: raw.request_in_flight === true
        ? iso(raw.in_flight_until)
        : null,
    service_accepted_at: iso(raw.service_accepted_at),
    cache_probe_in_flight: raw.cache_probe_in_flight === true,
    cache_probe_accepted_at: iso(raw.cache_probe_accepted_at),
    last_failure_class: raw.last_failure_class ?? null,
    failure_endpoint: raw.failure_endpoint ?? null,
    failure_stage: raw.failure_stage ?? null,
    manual_force: raw.manual_force === true,
    updated_at: new Date(now).toISOString()
};

let dismissRecoveredFailure = null;
if (raw.recovery_notification_pending === true) {
    raw.recovery_notification_pending = false;
    flow.set("security_vehicle_primary_refresh_v1", raw, "persistent");
    dismissRecoveredFailure = {
        notification: {
            id: "vehicle_primary_refresh_failed",
            dismiss_only: true
        }
    };
}

const discovery = {
    name: "Refresh Coordinator",
    unique_id: "vehicle_primary_refresh_coordinator",
    object_id: "vehicle_primary_refresh_coordinator",
    state_topic: "homeassistant/vehicle_primary/refresh/state",
    value_template: "{{ value_json.state }}",
    json_attributes_topic: "homeassistant/vehicle_primary/refresh/state",
    icon: "mdi:car-clock",
    device: {
        identifiers: ["vehicle_primary_bluelink"],
        name: "vehicle_primary",
        manufacturer: "Hyundai"
    }
};

return [[
    {
        topic: "homeassistant/sensor/creta_refresh_coordinator/config",
        payload: "",
        retain: true,
        qos: 1
    },
    {
        topic: "homeassistant/sensor/vehicle_primary_refresh_coordinator_source/config",
        payload: "",
        retain: true,
        qos: 1
    },
    {
        topic: "homeassistant/sensor/vehicle_primary_refresh_coordinator/config",
        payload: JSON.stringify(discovery),
        retain: true,
        qos: 1
    },
    {
        topic: "homeassistant/vehicle_primary/refresh/state",
        payload: JSON.stringify(status),
        retain: true,
        qos: 1
    }
], dismissRecoveredFailure];
