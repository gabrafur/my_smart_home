const testMode = msg._internet_test === true || msg.payload?.test_mode === true;
const suffix = testMode ? "__test" : "";
const store = testMode ? undefined : "persistent";
const get = (key) => store ? flow.get(`${key}${suffix}`, store) : flow.get(`${key}${suffix}`);
const report = msg.remote_access_report ?? get("internet_remote_access_report_v1");
const internet = msg.internet_state ?? get("internet_monitor_state_v1") ?? { phase: "unknown" };
const state = get("internet_remote_access_state_v1") ?? {
    version: 1, phase: "unknown", incident_open: false,
    consecutive_failures: 0, last_request_at: 0
};
const reportTime = Date.parse(report?.checked_at ?? "");
const now = Number(msg.monitor_now ?? msg.remote_access_now ?? (testMode && Number.isFinite(reportTime) ? reportTime : Date.now()));
const checkedAt = Date.parse(report?.checked_at ?? "");
const fresh = Number.isFinite(checkedAt) &&
    now - checkedAt <= Number(msg.policy.remote_access_report_stale_s) * 1000;
const sshHealthy = fresh && report?.services?.remote_shell?.healthy === true;
const codexHealthy = fresh && report?.services?.codex_remote?.healthy === true;
let reason = "telemetry_stale";
if (fresh && !sshHealthy) reason = String(report.services.remote_shell.reason ?? "ssh_unavailable");
else if (fresh && sshHealthy && !codexHealthy) reason = String(report.services.codex_remote.reason ?? "codex_unavailable");
else if (fresh) reason = "ready";
msg._internet_test = testMode;
msg.remote_access = {
    now, report, internet, state, fresh, ssh_healthy: sshHealthy,
    codex_healthy: codexHealthy,
    healthy: sshHealthy && codexHealthy,
    codex_recoverable: fresh && sshHealthy && !codexHealthy && report?.services?.codex_remote?.installed === true,
    reason,
    request_due: now - Number(state.last_request_at ?? 0) >= Number(msg.policy.remote_access_recovery_cooldown_s) * 1000
};
return msg;
