let payload = msg.payload;
if (Buffer.isBuffer(payload)) payload = payload.toString("utf8");
try {
    if (typeof payload === "string") payload = JSON.parse(payload);
} catch {
    payload = null;
}
const services = payload?.services;
const remote = services?.codex_remote;
const legacy = payload?.schema_version === 1;
const v2 = payload?.schema_version === 2;
const remoteValid = typeof remote?.installed === "boolean" && (legacy ?
    typeof remote?.healthy === "boolean" && (!remote.healthy || remote.installed) :
    v2 && (remote.listener_state === "unknown" ? remote.healthy === null :
        remote.listener_state === "present" ? remote.healthy === remote.installed :
        remote.listener_state === "absent" && remote.healthy === false));
const valid = (legacy || v2) &&
    Number.isFinite(Date.parse(payload?.checked_at ?? "")) &&
    typeof services?.remote_shell?.healthy === "boolean" &&
    remoteValid;
msg._internet_test = msg._internet_test === true || payload?.test_mode === true;
msg.remote_access_report_valid = valid;
if (!valid) return msg;
const report = {
    schema_version: 2,
    checked_at: payload.checked_at,
    services: {
        remote_shell: {
            healthy: services.remote_shell.healthy,
            reason: String(services.remote_shell.reason ?? "unknown").slice(0, 80)
        },
        codex_remote: {
            installed: remote.installed,
            healthy: legacy && remote.healthy === false ? null : remote.healthy,
            listener_state: legacy ? remote.healthy ? "present" : "unknown" : remote.listener_state,
            reason: String(remote.reason ?? "unknown").slice(0, 80)
        }
    }
};
const key = msg._internet_test ? "internet_remote_access_report_v1__test" : "internet_remote_access_report_v1";
if (msg._internet_test) flow.set(key, report);
else flow.set(key, report, "persistent");
flow.set(key + "_received", true, "memoryOnly");
msg.remote_access_report = report;
return msg;
