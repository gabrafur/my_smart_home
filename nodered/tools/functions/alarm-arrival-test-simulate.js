if (msg._location_test !== true || msg.alarm_arrival_test !== true || typeof msg.confirm_action !== "string") return null;
msg.payload = { event: { action: msg.confirm_action }, test_mode: true, simulated: true, dispatched: false };
msg.alarm_arrival_test_notification = { simulated: true, dispatched: false };
return msg;
