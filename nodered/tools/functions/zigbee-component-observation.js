const test = msg._zigbee_test === true;
const key = "zigbee_component_observations" + (test ? "__test" : "");
const store = test ? undefined : "memoryOnly";
const observations = flow.get(key, store) || {};
const previous = observations[msg.zigbee_component];
const observation = { state: msg.zigbee_component_availability,
    changed_at: previous?.state === msg.zigbee_component_availability ? previous.changed_at : msg.zigbee_now };
observations[msg.zigbee_component] = observation;
flow.set(key, observations, store);
msg.zigbee_component_stable_ms = Math.max(0, msg.zigbee_now - observation.changed_at);
return msg;
