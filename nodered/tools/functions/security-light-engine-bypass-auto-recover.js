const data = msg._engine_bypass;
const set = (key, value) => data.store ? flow.set(key, value, data.store) : flow.set(key, value);
set(data.state_key, false);
set(data.automatic_key, false);
data.enabled = false;
data.automatic = false;
data.communication_failed = false;
return msg;
