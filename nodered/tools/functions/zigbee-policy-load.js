const policy = flow.get("zigbee_monitor_policy_v2", "persistent");
msg.policy_available = Boolean(policy && policy.version === 2);
msg.policy = msg.policy_available ? policy : null;
return msg;
