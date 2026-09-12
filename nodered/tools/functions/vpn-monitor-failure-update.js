const current = msg.vpn.current;
current.recovery_started_at = null;
current.reason = msg.vpn.failure_reason;
current.phase = "checking";
if (!Number.isFinite(current.failure_started_at)) current.failure_started_at = msg.vpn.now;
msg.vpn.failure_elapsed_s = (msg.vpn.now - current.failure_started_at) / 1000;
return msg;
