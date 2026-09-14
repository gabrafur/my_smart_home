const data = msg._light_context;
const suffix = data.test_mode ? "__test" : "";
const get = (name, store) => data.test_mode || !store
    ? flow.get(name + suffix) : flow.get(name, store);
const set = (name, value, store) => data.test_mode || !store
    ? flow.set(name + suffix, value) : flow.set(name, value, store);
const key = "security_light_pending_arrival_v1";
let pending = get(key, "persistent");
if (pending && data.lifecycle.active_by_arrival === true) {
    set(key, null, "persistent");
    pending = null;
}
if (pending) {
    const queuedAt = Number(pending.queued_at ?? 0);
    const expiresAt = Number(pending.expires_at ?? 0);
    const ttlMs = Number(data.location_policy.arrival_recovery_minutes) * 60000;
    let valid = Boolean(pending.message) && Number.isFinite(queuedAt) && queuedAt > 0 &&
        queuedAt <= data.now + data.future_ms && Number.isFinite(expiresAt) &&
        data.now <= expiresAt && expiresAt - queuedAt <= ttlMs + 1000;
    let reason = data.now > expiresAt ? "arrival_recovery_expired" : null;
    if (valid && pending.version === 2 && pending.retention === "while_approaching" &&
        ["resident_primary", "resident_secondary"].includes(pending.source)) {
        const resident = data.people[pending.source];
        valid = resident?.ready === true && resident?.stale !== true && resident?.state === "near_home";
        if (!valid) reason = resident?.state === "home" ? "resident_home" :
            resident?.stale === true || resident?.ready !== true ? "resident_location_stale" : "resident_left_approach_zone";
    } else if (valid && pending.retention !== "recovery_window") {
        valid = false;
        reason = "invalid_retention";
    }
    if (!valid) {
        set(key, null, "persistent");
        node.warn(`iluminacao_seguranca: chegada pendente cancelada (${reason ?? "invalid_pending"})`);
        pending = null;
    }
}
data.pending = pending;
data.replay_ready = Boolean((pending || data.engine_on_arrival) &&
    data.sun_ready && data.dark &&
    (data.engine_allowed || data.bypass_allowed));
data.reconcile = data.test_mode ? null : { payload: { kind: "reconcile_signal", reason: "context_update" } };
if (["people_context", "vehicle_primary_context"].includes(data.kind) && !data.accepted) {
    data.lifecycle_message = null;
} else {
    msg.payload = {
        event: data.original_payload.event ?? "context_update",
        reason: data.original_payload.reason,
        source: data.original_payload.source,
        trigger_state: data.original_payload.trigger_state,
        trigger_prev_state: data.original_payload.trigger_prev_state,
        confirmed_home_transition: data.original_payload.confirmed_home_transition === true,
        vehicle_primary_ready: data.vehicle.ready === true,
        vehicle_primary_lighting_ready: data.vehicle.lighting_ready === true,
        vehicle_primary_engine_on: data.vehicle.engine_on,
        vehicle_primary_engine_state_valid: data.vehicle.engine_state_valid === true,
        engine_communication_failed: data.communication_failed,
        vehicle_primary_unlocked: data.vehicle.unlocked,
        vehicle_primary_in_use: data.vehicle.in_use,
        engine_bypass_enabled: data.bypass_enabled,
        engine_bypass_allowed: data.bypass_allowed,
        active: data.lifecycle.active_by_arrival === true
    };
    if (data.test_mode) {
        msg._location_test = true;
        msg._location_test_case = data.test_case;
        msg.payload.test_mode = true;
        msg.payload.test_case = data.test_case;
    }
    data.lifecycle_message = msg;
}
return msg;
