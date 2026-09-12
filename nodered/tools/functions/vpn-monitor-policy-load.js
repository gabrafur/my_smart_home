msg.policy = flow.get("vpn_monitor_policy_v1", "persistent");
msg.policy_available = Boolean(msg.policy?.version === 1);
return msg;
