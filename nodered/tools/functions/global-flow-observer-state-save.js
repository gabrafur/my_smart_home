const data = msg._observer_event;
if (data.store) flow.set(data.state_key, data.state, data.store);
else flow.set(data.state_key, data.state);
return null;
