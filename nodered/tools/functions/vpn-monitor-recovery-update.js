const current = msg.vpn.current;
current.failure_started_at = null;
current.reason = "running";
if (!Number.isFinite(current.recovery_started_at)) current.recovery_started_at = msg.vpn.now;
msg.vpn.recovery_elapsed_s = (msg.vpn.now - current.recovery_started_at) / 1000;
current.phase = "recovering";
return msg;
