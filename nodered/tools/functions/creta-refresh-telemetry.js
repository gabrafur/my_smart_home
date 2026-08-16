const raw = flow.get("security_creta_refresh_v1", "persistent") ?? {};
const now = Date.now();
let state = raw.state ?? "idle";
let deadline = null;

if (raw.awaiting_evidence === true) {
    deadline = Number(raw.next_retry_at ?? raw.next_allowed_at ?? 0) || null;
    if (state !== "refreshing" || now - Number(raw.last_attempt_at ?? 0) >= 30 * 1000) {
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
    manual_force: raw.manual_force === true,
    updated_at: new Date(now).toISOString()
};

const discovery = {
    name: "Refresh Coordinator",
    unique_id: "creta_refresh_coordinator",
    object_id: "creta_refresh_coordinator",
    state_topic: "homeassistant/creta/refresh/state",
    value_template: "{{ value_json.state }}",
    json_attributes_topic: "homeassistant/creta/refresh/state",
    icon: "mdi:car-clock",
    device: {
        identifiers: ["creta_bluelink"],
        name: "Creta",
        manufacturer: "Hyundai"
    }
};

return [[
    {
        topic: "homeassistant/sensor/creta_refresh_coordinator/config",
        payload: JSON.stringify(discovery),
        retain: true,
        qos: 1
    },
    {
        topic: "homeassistant/creta/refresh/state",
        payload: JSON.stringify(status),
        retain: true,
        qos: 1
    }
]];
