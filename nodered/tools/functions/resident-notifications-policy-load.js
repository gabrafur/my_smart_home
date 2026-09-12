const record = flow.get("resident_notifications_policy_v2", "persistent");
msg.policy_available = record?.version === 2 && record.policy?.version === 2;
msg.policy = msg.policy_available ? record.policy : null;
return msg;
