if (
    msg.payload?.kind !== "arrival" ||
    msg.payload?.arrival_source_type !== "vehicle_primary"
) return null;

const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;
const key = TEST_MODE
    ? "security_vehicle_primary_trip_action_v1__test"
    : "security_vehicle_primary_trip_action_v1";
const previous = TEST_MODE ? flow.get(key) : flow.get(key, "persistent");
const now = Number(msg.payload?.test_now) || Date.now();
const eventKey = [
    msg.payload.source,
    msg.payload.arrival_stage,
    msg.payload.event_at ?? msg.payload.trigger_state ?? "?"
].join(":");
const previousAt = Number(previous?.at ?? 0);
if (
    previous?.event_key === eventKey &&
    previousAt <= now + 60 * 1000 &&
    now - previousAt < 10 * 60 * 1000
) return null;

const record = { version: 2, event_key: eventKey, at: now };
if (TEST_MODE) flow.set(key, record);
else flow.set(key, record, "persistent");

let wake = null;
if (msg.payload.request_vehicle_primary_wake === true) {
    wake = structuredClone(msg);
    wake.payload = {
        ...wake.payload,
        contract: "security.refresh-command.v1",
        kind: "refresh_command",
        reason: "vehicle_primary_arrival",
        recovery_needed: true,
        force_recovery: true,
        require_lighting_ready: true,
        test_mode: TEST_MODE,
        issued_at: now
    };
}

const trip = structuredClone(msg);
trip.payload = {
    ...trip.payload,
    side_effect: "vehicle_primary.refresh_trip_info",
    test_mode: TEST_MODE
};

return [wake, trip];
