const TEST_MODE = msg._vpn_test === true || msg.payload?.test_mode === true;
const KEY = TEST_MODE ? "vpn_monitor_report_v1__test" : "vpn_monitor_report_v1";
const STORE = TEST_MODE ? undefined : "persistent";
const setValue = (value) => STORE ? flow.set(KEY, value, STORE) : flow.set(KEY, value);

let payload = msg.payload;
if (Buffer.isBuffer(payload)) payload = payload.toString("utf8");
if (typeof payload === "string") {
    try {
        payload = JSON.parse(payload);
    } catch {
        node.warn("VPN_MONITOR_INVALID_REPORT invalid_json");
        return null;
    }
}
if (payload?.schema_version !== 1 || !Array.isArray(payload.vpns)) {
    node.warn("VPN_MONITOR_INVALID_REPORT invalid_schema");
    return null;
}

const vpns = payload.vpns
    .filter((vpn) => vpn && vpn.installed === true)
    .map((vpn) => ({
        role: String(vpn.role ?? "").slice(0, 80),
        kind: String(vpn.kind ?? "").slice(0, 80),
        installed: true,
        healthy: vpn.healthy === true,
        status: vpn.healthy === true ? "online" : "offline",
        reason: String(vpn.reason ?? "unknown").slice(0, 80),
        checked_at: String(vpn.checked_at ?? payload.checked_at ?? "").slice(0, 40)
    }))
    .filter((vpn) => vpn.role && vpn.kind);

setValue({
    schema_version: 1,
    checked_at: String(payload.checked_at ?? "").slice(0, 40),
    received_at: Number(msg.vpn_now ?? Date.now()),
    vpns
});
msg.payload = { test_mode: TEST_MODE, observer_kind: "vpn_report" };
return msg;
