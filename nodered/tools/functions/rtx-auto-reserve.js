const test = msg.test_mode === true || msg._rtx_test === true;
const key = test ? 'rtx_auto_lifecycle_test' : 'rtx_auto_lifecycle_v1';
const store = test ? undefined : 'persistent';
const previous = flow.get(key,store) || {};
// Recheck reservation at the effect boundary to reject queued duplicates.
if (previous.pending || previous.blocked) return null;
const now = Number(msg.rtx_now) || Date.now();
const state = {...previous,attempts:(previous.attempts || 0)+1,pending:true,last_attempt_at:now};
state.operation_id = `rtx_${now}_${state.attempts}`;
flow.set(key,state,store);
msg.operation_id = state.operation_id;
return msg;
