const record = {
    version: 1,
    policy: msg.policy_candidate,
    updated_at: Date.now()
};
flow.set("resident_notifications_policy_v1", record, "persistent");
msg.policy = record.policy;
node.status({ fill: "green", shape: "dot", text: "política válida aplicada" });
return null;
