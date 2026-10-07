const testMode = msg.test_mode === true || msg._rtx_test === true;
if (testMode) return null;
const key = "local_ai_rtx_alert_incident_open_v1";
if (flow.get(key, "persistent") !== true) return null;
flow.set(key, false, "persistent");
delete msg.reset;
delete msg.rtx_alert_condition;
msg.topic = "production_alert_recovery";
return msg;
