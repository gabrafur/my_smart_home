const testMode = msg._vpn_test === true || msg.payload?.test_mode === true;
const suffix = testMode ? "__test" : "";
const store = testMode ? undefined : "persistent";
const get = (key) => store ? flow.get(`${key}${suffix}`, store) : flow.get(`${key}${suffix}`);
const now = Number(msg.vpn_now ?? Date.now());
const report = get("vpn_monitor_report_v1") ?? { checked_at: null, received_at: 0, vpns: [] };
const internet = get("vpn_monitor_internet_v1") ?? { phase: "unknown" };
const states = get("vpn_monitor_state_v1") ?? {};
const previous = states.vpn_primary ?? {
    phase: "checking", incident_open: false, failure_started_at: null,
    recovery_started_at: null, last_notification_at: null
};
const checkedAt = Date.parse(report.checked_at ?? "");
const reportFresh = Number.isFinite(checkedAt) && now - checkedAt <= msg.policy.report_stale_s * 1000;
const sample = (report.vpns ?? []).find((item) => item.role === "vpn_primary");
const failureReason = !reportFresh ? "telemetry_stale" : sample ? String(sample.reason ?? "not_online") : "vpn_not_detected";
msg.vpn = {
    test_mode: testMode, suffix, store, now, report, internet, states,
    current: { ...previous, kind: "tailscale", label: "Tailscale" },
    internet_online: internet.phase === "online",
    healthy: reportFresh && sample?.healthy === true,
    failure_reason: failureReason
};
return msg;
