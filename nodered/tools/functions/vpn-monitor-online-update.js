const current = msg.vpn.current;
current.failure_started_at = null;
current.recovery_started_at = null;
current.reason = "running";
current.phase = "online";
return msg;
