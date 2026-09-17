const record = {
    version: 3,
    policy: msg.policy_candidate,
    updated_at: Date.now()
};
flow.set("resident_notifications_policy_v3", record, "persistent");
msg.policy = record.policy;
node.status({ fill: "green", shape: "dot", text: "política válida aplicada" });
return null;
