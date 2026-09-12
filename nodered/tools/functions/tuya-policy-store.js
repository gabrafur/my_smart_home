flow.set("tuya_monitor_policy_v1", msg.policy_candidate, "persistent");
node.status({ fill: "green", shape: "dot", text: "política válida" });
return null;
