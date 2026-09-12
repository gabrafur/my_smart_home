const testMode = msg._tuya_test === true;
const summaryKey = testMode ? "tuya_device_monitor_summary_v1__test" : "tuya_device_monitor_summary_v1";
const incidentsKey = testMode ? "tuya_device_incidents_v1__test" : "tuya_device_incidents_v1";
const get = (key) => testMode ? flow.get(key) : flow.get(key, "persistent");
const summary = get(summaryKey) || {};
const incidents = get(incidentsKey) || {};
const latest = (field) => Object.values(incidents).map((item) => item?.[field]).filter((value) =>
    typeof value === "string" && Number.isFinite(Date.parse(value))).sort().at(-1);
summary.last_outage_at = latest("last_outage_at") || summary.last_outage_at || null;
summary.last_recovery_at = latest("last_recovery_at") || summary.last_recovery_at || null;
summary.last_checked_at = msg.tuya_now_iso;
summary.last_success_at = msg.tuya_now_iso;
if (testMode) flow.set(summaryKey, summary); else flow.set(summaryKey, summary, "persistent");
msg.tuya_publications = [
    { topic: "nodered/infrastructure/tuya/connection", payload: msg.tuya_phase === "online" ? "ON" : "OFF" },
    { topic: "nodered/infrastructure/tuya/attributes", payload: JSON.stringify({
        state: msg.tuya_phase, checked_at: msg.tuya_now_iso,
        monitored_device_count: msg.tuya_monitored_count,
        offline_device_count: msg.tuya_offline_count,
        confirmed_offline_device_count: msg.tuya_confirmed_count,
        offline_devices: msg.tuya_offline_devices, platforms: msg.tuya_platforms,
        last_outage: summary.last_outage_at || "Nenhuma queda confirmada",
        last_recovery: summary.last_recovery_at || "Nenhuma recuperação registrada",
        failure_confirmation_s: msg.policy.failure_confirmation_s,
        recovery_confirmation_s: msg.policy.recovery_confirmation_s,
        reminder_interval_h: msg.policy.reminder_interval_h,
        next_reminders: msg.tuya_next_reminders
    }) },
    { topic: "nodered/infrastructure/tuya/state", payload: msg.tuya_phase }
];
return msg;
