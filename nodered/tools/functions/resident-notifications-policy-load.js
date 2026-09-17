const record = flow.get("resident_notifications_policy_v3", "persistent");
msg.policy_available = record?.version === 3 && record.policy?.version === 3;
msg.policy = msg.policy_available ? record.policy : null;
return msg;
