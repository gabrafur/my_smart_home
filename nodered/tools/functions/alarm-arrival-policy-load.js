msg.policy = flow.get("alarm_arrival_policy_v1", "persistent");
msg.policy_available = msg.policy?.version === 1;
return msg;
