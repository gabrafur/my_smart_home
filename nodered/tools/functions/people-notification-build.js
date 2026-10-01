const data = msg._people;
if (!data?.notification_eligible) return msg;
const notifications = data.notification_candidates.map(({role, resident, cycle}) => {
cycle.issued = true;
return {
    _location_test: data.test_mode,
    payload: {
        contract: "security.arrival.v1", kind: "arrival",
        source: role, arriving: [role], arrival_source_type: "person",
        arrival_stage: "approach", arrival_direction: "returning",
        external_cycle_confirmed: true, notification_only: true,
        notification_cycle_id: cycle.id,
        notification_radius_m: Number(data.policy.notification_approach_radius_m),
        event_at: resident.updated_at,
        arrival_resident_snapshot: { ...resident },
        test_mode: data.test_mode,
        test_case: msg._location_test_case ?? null
    }
};
});
// Preserve a simultaneous HOME fallback for the other resident.
if (data.notification && !notifications.some(item =>
    item.payload.source === data.notification.payload.source)) notifications.push(data.notification);
data.notification = notifications.length === 1 ? notifications[0] : notifications;
flow.set(data.notification_state_key, data.notification_state,
    data.test_mode ? undefined : "persistent");
return msg;
