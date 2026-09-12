const record = { version: 1, policy: msg.policy_candidate, updated_at: Date.now() };
flow.set("internet_monitor_policy_v1", record, "persistent");
node.status({ fill: "green", shape: "dot", text: "política válida aplicada" });
return null;
