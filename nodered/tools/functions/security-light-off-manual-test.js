// Isolated synthetic fixtures enter the same context normalization and OFF gates.
const keys = ["security_light_lifecycle_v1", "vehicle_primary_context_v1", "security_light_physical_state",
    "security_light_physical_observed_at", "light_reconciled", "sun_ready", "security_light_off_diagnostic",
    "security_light_last_off_dry_run_v1", "security_light_engine_communication_failed"];
if (msg.topic === "reset") {
    for (const key of keys) flow.set(key + "__test", null);
    node.status({ fill: "grey", shape: "ring", text: "TESTE OFF resetado; produção preservada" });
    return null;
}
const now = Date.now();
const policy = global.get("security_light_policy_v1", "persistent");
flow.set("security_light_lifecycle_v1__test", { version: 1, active_by_arrival: true,
    on_since: now - 10000, force_off_at: now + Number(policy.backstop_minutes) * 60000, updated_at: now });
flow.set("security_light_physical_state__test", "on");
flow.set("security_light_physical_observed_at__test", now);
flow.set("light_reconciled__test", true);
flow.set("sun_ready__test", true);
flow.set("security_light_engine_communication_failed__test", false);
const observed = msg.topic === "old_off" ? now - 600000 : now;
msg._location_test = true;
msg.payload = { test_mode: true, kind: "vehicle_primary_context", updated_at: now,
    context: { ready: true, engine_state_valid: true, engine_on: false,
        telemetry_updated_at: observed, engine_updated_at: observed, updated_at: now } };
return msg;
