const data = msg._observer_evaluation;
const getState = () => data.store ? flow.get(data.state_key, data.store) : flow.get(data.state_key);
const state = getState();
if (state?.version !== 2) return null;
state.status_incidents ??= {};
delete state.status_incidents[data.key];
if (data.store) flow.set(data.state_key, state, data.store);
else flow.set(data.state_key, state);
return null;
