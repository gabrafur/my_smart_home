const policy = flow.get("global_observer_policy_v1", "persistent");
const days = policy?.error_retention_days;
if (!Number.isInteger(days) || days < 1 || days > 30) return null;
msg.payload = String(days);
return msg;
