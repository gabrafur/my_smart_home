const data = msg.home_refresh_due;
const pending = data.pending;
pending.issued_at = data.now;
pending.next_emit_at = data.now + Number(msg.policy.home_confirmation_retry_s) * 1000;
pending.attempts = Number(pending.attempts ?? 0) + 1;
pending.updated_at = data.now;
if (msg._location_test === true) flow.set(data.pending_key, pending);
else flow.set(data.pending_key, pending, "persistent");
msg.payload = {
    kind: "refresh_tick",
    origin: "contexto_chegadas_home_confirmation",
    reason: "resident_arrival_confirmation",
    force_recovery: true,
    require_lighting_ready: false,
    resident_arrival_force: true,
    requested_at: data.now,
    arrival_source: pending.source,
    arrival_stage: "home",
    arrival_observed_at: pending.arrival_observed_at,
    ...(msg._location_test === true ? {
        test_mode: true,
        test_case: msg._location_test_case ?? msg.payload?.test_case ?? "home_confirmation"
    } : {})
};
node.status({ fill: "green", shape: "dot", text: `refresh HOME emitido (${pending.attempts})` });
return msg;
