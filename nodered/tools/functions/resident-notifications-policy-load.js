const record = flow.get("resident_notifications_policy_v1", "persistent");
msg.policy_available = record?.version === 1 && record.policy?.version === 1;
msg.policy = msg.policy_available ? record.policy : null;
return msg;
