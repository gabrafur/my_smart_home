const policy = { version: 1, ...msg.policy_candidate };
flow.set("vpn_monitor_policy_v1", policy, "persistent");
node.status({ fill: "green", shape: "dot", text: "política válida" });
return null;
