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
const get = (key) => msg._location_test === true
    ? flow.get(key)
    : flow.get(key, "persistent");
const set = (key, value) => msg._location_test === true
    ? flow.set(key, value)
    : flow.set(key, value, "persistent");
const pendingState = get(data.pending_key)?.version === 2
    ? get(data.pending_key)
    : { version: 2, residents: {} };
pendingState.residents = { ...(pendingState.residents ?? {}), [data.source]: record };
pendingState.updated_at = msg.context_now;
const lastState = data.last_state?.version === 2
    ? data.last_state
    : { version: 2, residents: {} };
lastState.residents = { ...(lastState.residents ?? {}), [data.source]: last };
lastState.updated_at = msg.context_now;
set(data.pending_key, pendingState);
set(data.last_key, lastState);
node.status({ fill: "blue", shape: "dot", text: `HOME: refresh em ${policy.home_confirmation_delay_s} s` });
return null;
