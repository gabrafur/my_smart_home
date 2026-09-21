// One persistent incident per canonical subject. Test state never touches production.
const event = msg.operational_alert;
if (!event || typeof event.active !== "boolean" || !event.subject) return null;
const testMode = event.test_mode === true;
const key = "operational_action_alerts_v1" + (testMode ? "__test" : "");
const store = testMode ? undefined : "persistent";
const state = flow.get(key, store) ?? {};
const identity = event.source + ":" + event.subject;
const previous = state[identity];
const signature = event.reason + ":" + event.version;
if (event.active && previous?.signature === signature) return null;
if (!event.active && !previous) return null;
if (event.active) state[identity] = { signature };
else delete state[identity];
flow.set(key, state, store);
return {
    _global_observer_test: testMode,
    payload: {
        test_mode: testMode, observer_kind: "action_required",
        incident_key: identity, source: event.source,
        persistent_notification_operation: event.active ? "create" : "dismiss",
        mobile_notification: event.active,
        reason: event.reason, severity: "warning"
    },
    alert: {
        title: (testMode ? "TESTE — " : "") + event.title,
        message: (testMode ? "TESTE — " : "") + event.message
    }
};
