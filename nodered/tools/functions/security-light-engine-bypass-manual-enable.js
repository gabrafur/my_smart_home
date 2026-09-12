const data = msg._engine_bypass;
const set = (key, value) => data.store ? flow.set(key, value, data.store) : flow.set(key, value);
set(data.state_key, true);
set(data.automatic_key, false);
data.enabled = true;
data.automatic = false;
data.communication_failed = undefined;
return msg;
