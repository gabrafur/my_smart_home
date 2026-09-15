const data = msg.home_refresh;
const policy = msg.policy;
const dueAt = data.event_at + Number(policy.home_confirmation_delay_s) * 1000;
const record = {
    version: 1,
    signature: data.signature,
    source: data.source,
    previous_state: data.previous_state,
    arrival_observed_at: data.event_at,
    due_at: dueAt,
    expires_at: dueAt + Number(policy.home_confirmation_expiry_min) * 60000,
    engine_on_at_arrival: data.engine_on_at_arrival,
    issued_at: null,
    next_emit_at: dueAt,
    attempts: 0,
    updated_at: msg.context_now
};
const last = { signature: data.signature, observed_at: data.event_at };
if (msg._location_test === true) {
    flow.set(data.pending_key, record);
    flow.set(data.last_key, last);
} else {
    flow.set(data.pending_key, record, "persistent");
    flow.set(data.last_key, last, "persistent");
}
node.status({ fill: "blue", shape: "dot", text: `HOME: refresh em ${policy.home_confirmation_delay_s} s` });
return null;
