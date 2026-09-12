const testMode = msg._tuya_test === true;
const incidentsKey = testMode ? "tuya_device_incidents_v1__test" : "tuya_device_incidents_v1";
const observationsKey = testMode ? "tuya_device_observations_v1__test" : "tuya_device_observations_v1";
const get = (key, store) => testMode ? flow.get(key) : flow.get(key, store);
const observation = msg.payload;
const observations = get(observationsKey, "memoryOnly") || {};
const previous = observations[observation.key];
observations[observation.key] = {
    state: observation.raw_state,
    changed_at: previous?.state === observation.raw_state ? previous.changed_at : msg.tuya_now
};
if (testMode) flow.set(observationsKey, observations);
else flow.set(observationsKey, observations, "memoryOnly");
const incidents = get(incidentsKey, "persistent") || {};
const current = incidents[observation.key] || { incident_open: false, phase: "checking" };
const last = Date.parse(current.last_notification_at || current.outage_started_at || "");
const next = Date.parse(current.next_reminder_at || "");
msg.tuya_incidents_key = incidentsKey;
msg.tuya_incidents = incidents;
msg.tuya_device = observation;
msg.tuya_device_state = current;
msg.tuya_stable_for_ms = Math.max(0, msg.tuya_now - Number(observations[observation.key].changed_at || msg.tuya_now));
msg.tuya_next_reminder_ms = Number.isFinite(next) ? next :
    (Number.isFinite(last) ? last + msg.policy.reminder_interval_h * 3600000 : msg.tuya_now + msg.policy.reminder_interval_h * 3600000);
return msg;
