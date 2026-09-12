flow.set("alarm_arrival_policy_v1", { version: 1, ...msg.policy_candidate }, "persistent");
node.status({ fill: "green", shape: "dot", text: "política válida" });
return null;
