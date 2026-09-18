let payload = msg.payload;
if (Buffer.isBuffer(payload)) payload = payload.toString("utf8");
try {
    if (typeof payload === "string") payload = JSON.parse(payload);
} catch {
    payload = null;
}
const services = payload?.services;
const valid = payload?.schema_version === 1 &&
    Number.isFinite(Date.parse(payload?.checked_at ?? "")) &&
    typeof services?.remote_shell?.healthy === "boolean" &&
    typeof services?.codex_remote?.healthy === "boolean" &&
    typeof services?.codex_remote?.installed === "boolean";
msg._internet_test = msg._internet_test === true || payload?.test_mode === true;
if (!valid) {
    msg.remote_access_report_valid = false;
    return msg;
}
const report = {
    schema_version: 1,
    checked_at: payload.checked_at,
    services: {
        remote_shell: {
            healthy: services.remote_shell.healthy,
            reason: String(services.remote_shell.reason ?? "unknown").slice(0, 80)
        },
        codex_remote: {
            installed: services.codex_remote.installed,
            healthy: services.codex_remote.healthy,
            reason: String(services.codex_remote.reason ?? "unknown").slice(0, 80)
        }
    }
};
const key = msg._internet_test ? "internet_remote_access_report_v1__test" : "internet_remote_access_report_v1";
if (msg._internet_test) flow.set(key, report);
else flow.set(key, report, "persistent");
msg.remote_access_report_valid = true;
msg.remote_access_report = report;
return msg;
