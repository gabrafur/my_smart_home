const recovery = msg.notification_recovery;
const state = msg.notification_resident_state;
const action = msg.notification_state_action;

if (action === "rearm") {
    state.notified = false;
    if (msg.resident_previous !== "not_home") state.away_cycle = true;
} else if (action === "home") {
    state.away_cycle = false;
} else if (action === "notified") {
    state.notified = true;
    state.last_notification_key = msg.notification_key;
    state.last_notification_at = Date.now();
}

recovery.residents[msg.resident_source] = state;
recovery.updated_at = Date.now();
if (msg._location_test === true) flow.set(msg.notification_state_key, recovery);
else flow.set(msg.notification_state_key, recovery, "persistent");
return msg;
