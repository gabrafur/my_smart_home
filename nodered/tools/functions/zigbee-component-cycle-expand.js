const test = msg._zigbee_test === true;
const key = "zigbee_component_observations" + (test ? "__test" : "");
const observations = flow.get(key, test ? undefined : "memoryOnly") || {};
return [Object.entries(observations).map(([device, value]) => ({
    _zigbee_test: test, monitor_now: Number(msg.monitor_now ?? Date.now()),
    topic: "zigbee2mqtt/" + device + "/availability", payload: value.state
}))];
