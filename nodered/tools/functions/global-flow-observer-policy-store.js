const value = msg.observer_policy_candidate;
if (value?.version !== 1 || value?.complete !== true) return null;
flow.set("global_observer_policy_v1", value, "persistent");
msg.payload = { kind: "global_observer_policy", ...value };
return msg;
