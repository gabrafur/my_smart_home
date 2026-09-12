const data = msg._engine_bypass;
const set = (key, value) => data.store ? flow.set(key, value, data.store) : flow.set(key, value);
if (!data.state_defined) set(data.state_key, false);
data.enabled = data.previous_enabled;
data.automatic = data.automatic_owned;
data.communication_failed = undefined;
return msg;
