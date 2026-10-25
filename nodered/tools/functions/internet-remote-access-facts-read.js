const testMode = msg._internet_test === true || msg.payload?.test_mode === true;
const key = "internet_remote_access_report_v1";
const get = (name) => flow.get(name + (testMode ? "__test" : ""), testMode ? undefined : "persistent");
const report = msg.remote_access_report ?? get(key);
const remote = report?.services?.codex_remote;
const internet = msg.internet_state ?? get("internet_monitor_state_v1") ?? { phase: "unknown" };
const state = get("internet_remote_access_state_v1") ?? {
    version: 1, phase: "unknown", incident_open: false,
    consecutive_failures: 0, last_request_at: 0
};
const at = Date.parse(report?.checked_at ?? "");
const now = Number(msg.monitor_now ?? msg.remote_access_now ?? (testMode && Number.isFinite(at) ? at : Date.now()));
const fresh = Number.isFinite(at) && now >= at && now - at <= msg.policy.remote_access_report_stale_s * 1000;
const known = fresh && ["present", "absent"].includes(remote?.listener_state) && typeof remote.healthy === "boolean";
const ssh = fresh && report?.services?.remote_shell?.healthy === true;
const codex = fresh && remote?.healthy === true;
const reason = !fresh ? "telemetry_stale" : !known ? "listener_observation_unconfirmed" :
    !ssh ? report.services.remote_shell.reason : !codex ? remote.reason : "ready";
msg._internet_test = testMode;
msg.remote_access = {
    report_ready: known && (testMode || flow.get(key + "_received", "memoryOnly") === true),
    now, report, internet, state, fresh, ssh_healthy: ssh, codex_healthy: codex,
    codex_observation_state: known ? "observed" : "unknown", healthy: ssh && codex,
    codex_recoverable: known && ssh && remote.listener_state === "absent" && remote.installed === true,
    reason,
    request_due: now - Number(state.last_request_at ?? 0) >= msg.policy.remote_access_recovery_cooldown_s * 1000
};
return msg;
