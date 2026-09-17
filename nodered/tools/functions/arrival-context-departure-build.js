const record = { key: msg.departure_signature, at: msg.context_now };
if (msg._location_test === true) flow.set(msg.departure_key, record);
else flow.set(msg.departure_key, record, "persistent");
const people = msg.payload.context || {};
const vehicleKey = msg._location_test === true ? "vehicle_primary_context_v1__test" : "vehicle_primary_context_v1";
const vehicle = flow.get(vehicleKey) || {};
msg.context_departure_selected = true;
msg.context_departure_command = {
    contract: "security.refresh-command.v1", kind: "refresh_command",
    reason: "resident_departure", recovery_reason: "resident_departure",
    resident_departure_force: true, departure_source: msg.departure_source,
    departure_state: msg.payload.trigger_state, departure_event_at: msg.departure_event_at,
    resident_primary_state: people.resident_primary?.state ?? null,
    resident_secondary_state: people.resident_secondary?.state ?? null,
    resident_primary_ready: people.resident_primary?.ready === true,
    resident_secondary_ready: people.resident_secondary?.ready === true,
    any_resident_away: people.anyone_away === true,
    people_ready: msg.payload.ready === true, vehicle_primary_ready: vehicle.ready === true,
    force_recovery: true, origin: "resident_departure_transition", issued_at: msg.context_now,
    ...(msg._location_test === true ? { test_mode: true, test_case: msg._location_test_case } : {})
};
return [{ ...msg, payload: msg.context_departure_command }, msg];
