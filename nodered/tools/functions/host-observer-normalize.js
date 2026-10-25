const test = msg._host_observer_test === true;
const now = test && Number.isFinite(msg._host_test_now) ? msg._host_test_now : Date.now();
const policy = flow.get("host_observer_policy_v1", "persistent");
if (!policy) return null;
let value;
try {
    value = typeof msg.payload === "string" && msg.payload.length <= 65536
        ? JSON.parse(msg.payload) : msg.payload;
} catch { value = null; }
const report = value?.schema_version === 1 && value.collection_error === null ? value.report : null;
const stamp = value => {
    if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return NaN;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : NaN;
};
const at = stamp(report?.observed_at);
const valid = report?.schema_version === 1 && report.source === "fixed_readonly_host_observer" &&
    /^[a-f0-9]{64}$/.test(report.instance_id ?? "") && /^[a-f0-9]{64}$/.test(report.boot_id_sha256 ?? "") &&
    Number.isSafeInteger(report.sequence) && report.sequence >= 0 &&
    Array.isArray(report.events) && report.events.length <= 64 &&
    report.sources && report.resources?.data && Array.isArray(report.resources.collection_errors) && Number.isFinite(at) && at <= now + 1000;
return {
    _host_observer_test: test, _host_test_now: test ? now : undefined,
    _host_now: now, _host_policy: policy, _host_report_valid: !!valid,
    _host_report_age_ms: valid ? Math.max(0, now - at) : null,
    _host_resource_age_ms: valid && Number.isFinite(stamp(report.resources.observed_at)) &&
        stamp(report.resources.observed_at) <= at + 1000
        ? Math.max(0, now - stamp(report.resources.observed_at)) : null,
    _host_report: valid ? report : null
};
