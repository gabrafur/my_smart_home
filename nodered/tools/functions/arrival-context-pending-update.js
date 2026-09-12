const pending = msg.context_pending;
const domain = msg.context_domain;
pending[`${domain}_received`] = true;
pending[`${domain}_ready`] = msg.context_snapshot_accepted ? msg.payload.ready === true : msg.context_cached?.ready === true;
flow.set(msg.context_pending_key, pending);
msg.context_both_received = pending.people_received === true && pending.vehicle_primary_received === true;
msg.context_already_emitted = pending.emitted === true;
return msg;
