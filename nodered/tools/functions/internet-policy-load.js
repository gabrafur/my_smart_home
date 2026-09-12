const record = flow.get("internet_monitor_policy_v1", "persistent");
msg.policy_available = record?.version === 1 && record.policy?.version === 1;
msg.policy = msg.policy_available ? record.policy : null;
msg._internet_test = msg._internet_test === true || msg.payload?.test_mode === true;
return msg;
