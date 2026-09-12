const data = msg._refresh;
if (!data) return [null, null, null, null, null];
data.state.next_retry_at = data.state.awaiting_evidence === true
    ? data.state.next_allowed_at || null : null;
if (data.test_mode) flow.set(data.state_key, data.state);
else flow.set(data.state_key, data.state, "persistent");
const output = data.output;
const mirror = data.mirror_context === true ? { ...msg } : null;
delete msg._refresh;
if (output === 0) return [msg, mirror, null, null, null];
if (output === 2) return [null, null, msg, null, null];
if (output === 4) return [null, null, null, null, msg];
return [null, null, null, null, null];
