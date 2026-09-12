const policy = msg.external_policy_candidate;
if (policy?.version !== 1 || policy?.complete !== true) return null;
global.set("external_lighting_policy_v1", policy, "persistent");
return null;
