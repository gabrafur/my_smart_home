const pending = msg.context_pending;
const people = msg.context_people;
const vehicle = msg.context_vehicle;
const testMode = msg._location_test === true;
msg.payload = {
    contract: "security.refresh-command.v1", kind: "refresh_command",
    refresh_cycle_id: pending.cycle,
    anyone_away: people.anyone_away === true || vehicle.away === true,
    resident_primary_state: people.resident_primary?.state ?? null,
    resident_secondary_state: people.resident_secondary?.state ?? null,
    any_resident_away: people.best_location_away === true,
    people_arrival_armed: { ...(people.arrival_armed ?? {}) },
    people_local_excursions: { ...(people.local_excursions ?? {}) },
    people_ready: pending.people_ready === true,
    people_recovery_needed: msg.context_people_recovery_needed,
    vehicle_primary_ready: pending.vehicle_primary_ready === true,
    contexts_ready: msg.context_contexts_ready,
    recovery_needed: msg.context_recovery_needed,
    force_recovery: pending.force_recovery === true,
    require_lighting_ready: pending.require_lighting_ready === true,
    resident_arrival_force: pending.resident_arrival_force === true,
    arrival_source: pending.arrival_source ?? null,
    arrival_stage: pending.arrival_stage ?? null,
    recovery_reason: msg.context_recovery_reason,
    origin: "contexto_chegadas",
    reason: pending.request_reason || (testMode
        ? (msg.context_recovery_needed ? "test_readiness_recovery_needed" : "paired_ready_test_snapshots")
        : (msg.context_recovery_needed ? msg.context_recovery_reason : "paired_ready_snapshots")),
    issued_at: msg.context_now,
    ready: msg.context_contexts_ready,
    rejected_snapshot_reason: msg.context_rejected_reason || null,
    ...(testMode ? { test_mode: true, test_case: msg._location_test_case } : {})
};
return msg;
