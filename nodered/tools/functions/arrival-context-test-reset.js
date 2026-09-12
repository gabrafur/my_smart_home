if (msg._location_test !== true && msg.payload?.test_mode !== true) return null;
for (const key of ["refresh_pending__test", "people_context_v1__test", "vehicle_primary_context_v1__test",
    "resident_departure_refresh_v1__test", "refresh_cycle_clock__test"]) flow.set(key, undefined);
msg._location_test = true;
msg._location_test_case = msg._location_test_case ?? msg.payload?.test_case ?? "context_coordinator";
msg._location_test_reset = true;
msg.payload = {
    kind: "refresh_tick", reason: "manual_location_test_reset",
    force_recovery: false, require_lighting_ready: false,
    test_mode: true, test_case: msg._location_test_case
};
node.status({ fill: "blue", shape: "dot", text: "estado sintético resetado" });
return msg;
