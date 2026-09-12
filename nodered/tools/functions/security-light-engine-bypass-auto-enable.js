const data = msg._engine_bypass;
const set = (key, value) => data.store ? flow.set(key, value, data.store) : flow.set(key, value);
set(data.state_key, true);
if (!data.previous_enabled) set(data.automatic_key, true);
data.enabled = true;
data.automatic = data.previous_enabled ? data.automatic_owned : true;
data.communication_failed = true;
return msg;
