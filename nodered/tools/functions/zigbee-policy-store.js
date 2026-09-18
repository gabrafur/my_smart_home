flow.set("zigbee_monitor_policy_v2", msg.policy_candidate, "persistent");
node.status({ fill: "green", shape: "dot", text: "política válida" });
return null;
