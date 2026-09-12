msg.policy = flow.get("storage_health_policy_v2", "persistent");
msg.policy_available = msg.policy?.version === 2;
return msg;
