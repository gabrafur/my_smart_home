const pending = msg.context_pending;
const people = msg.context_people;
const test = msg._location_test === true;
msg.payload = {
    contract: "security.refresh-command.v1", kind: "refresh_command",
    refresh_cycle_id: pending.cycle,
    anyone_away: people.anyone_away === true || msg.context_vehicle.away === true,
    any_resident_away: people.anyone_away === true,
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
    reason: pending.request_reason || (test
        ? (msg.context_recovery_needed ? "test_readiness_recovery_needed" : "paired_ready_test_snapshots")
        : (msg.context_recovery_needed ? msg.context_recovery_reason : "paired_ready_snapshots")),
    issued_at: msg.context_now,
    ready: msg.context_contexts_ready,
    rejected_snapshot_reason: msg.context_rejected_reason || null,
    ...(test ? { test_mode: true, test_case: msg._location_test_case } : {})
};
for (const role of ["resident_primary", "resident_secondary"]) {
    const item = people[role] ?? {};
    msg.payload[role + "_state"] = item.state ?? null;
    msg.payload[role + "_ready"] = item.ready === true;
    msg.payload[role + "_updated_at"] = item.updated_at ?? null;
    msg.payload[role + "_distance_m"] = item.distance_m ?? null;
}
return msg;
