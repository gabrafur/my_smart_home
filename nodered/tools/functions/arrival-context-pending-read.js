const key = msg._location_test === true ? "refresh_pending__test" : "refresh_pending";
const pending = flow.get(key);
msg.context_pending_key = key;
msg.context_pending = pending;
msg.context_cycle_match = Boolean(pending && msg.payload.refresh_cycle_id === pending.cycle);
return msg;
