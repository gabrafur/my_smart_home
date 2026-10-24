// Adapt observations and persisted lifecycle; visual switches own all thresholds.
const test = msg.test_mode === true || msg._rtx_test === true;
const key = test ? 'rtx_auto_lifecycle_test' : 'rtx_auto_lifecycle_v1';
const store = test ? undefined : 'persistent';
const now = Number(msg.rtx_now) || Date.now();
let state = flow.get(key,store) || {attempts:0,first_failure_at:now,pending:false,blocked:false,last_attempt_at:0};
const status = msg.rtx_status || {};
const healthAt = Date.parse(status.checked_at);
const host = msg.rtx_host_entity || {};
const hostAt = Date.parse(host.attributes?.collected_at || host.last_updated);
const policy = flow.get('rtx_auto_policy_v1','persistent') || {};
msg.auto = {
    ...state, now, policy,
    endpoint_available: status.available === true,
    known_failure: status.state === 'LOCAL_AI_UNAVAILABLE',
    host_online: host.state === 'online',
    health_age_seconds: Number.isFinite(healthAt) ? Math.max(0,(now-healthAt)/1000) : 1e9,
    host_age_seconds: Number.isFinite(hostAt) ? Math.max(0,(now-hostAt)/1000) : 1e9,
    observed_after_attempt: healthAt > state.last_attempt_at,
    failure_seconds: Math.max(0,(now-state.first_failure_at)/1000),
    since_attempt_seconds: (now-state.last_attempt_at)/1000,
};
flow.set(key,state,store);
return msg;
