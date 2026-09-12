const current = msg.vpn.current;
current.phase = "suppressed_internet";
current.failure_started_at = null;
current.recovery_started_at = null;
current.reason = `internet_${msg.vpn.internet.phase ?? "unknown"}`;
return msg;
