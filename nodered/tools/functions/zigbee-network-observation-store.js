const testMode = msg._zigbee_test === true;
const key = testMode ? "zigbee_bridge_observation__test" : "zigbee_bridge_observation";
const store = testMode ? undefined : "memoryOnly";
const previous = store ? flow.get(key, store) : flow.get(key);
const observation = {
    state: msg.zigbee_observed_state,
    changed_at: previous?.state === msg.zigbee_observed_state
        ? Number(previous.changed_at || msg.zigbee_now)
        : msg.zigbee_now
};
if (store) flow.set(key, observation, store);
else flow.set(key, observation);
return msg;
