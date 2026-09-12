const current = msg.vpn.current;
current.phase = "offline";
msg.vpn.reminder_due = current.incident_open === true &&
    msg.vpn.now - Number(current.last_notification_at ?? msg.vpn.now) >= msg.policy.reminder_s * 1000;
msg.vpn.notification_due = current.incident_open !== true || msg.vpn.reminder_due;
return msg;
