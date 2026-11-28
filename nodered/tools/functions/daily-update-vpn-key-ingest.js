// Keep only the sanitized key-expiry list from the host VPN report.
let payload = msg.payload;
if (Buffer.isBuffer(payload)) payload = payload.toString("utf8");
if (typeof payload === "string") {
    try {
        payload = JSON.parse(payload);
    } catch {
        node.status({ fill: "red", shape: "ring", text: "relatório inválido" });
        return null;
    }
}
if (payload?.schema_version !== 1 || !Array.isArray(payload.key_expiry)) {
    node.status({ fill: "grey", shape: "ring", text: "relatório sem validade de chaves" });
    return null;
}
const PLATFORMS = ["ios", "android", "windows", "macos", "linux", "other"];
const entries = payload.key_expiry
    .filter((entry) => ["host", "device"].includes(entry?.scope) && Number.isFinite(Date.parse(entry?.expires_at)))
    .slice(0, 50)
    .map((entry) => ({
        scope: entry.scope,
        platform: PLATFORMS.includes(entry.platform) ? entry.platform : "other",
        shared: entry.shared === true,
        expires_at: new Date(Date.parse(entry.expires_at)).toISOString()
    }));
flow.set("vpn_key_expiry_report_v1", {
    checked_at: String(payload.checked_at ?? "").slice(0, 40),
    entries
}, "persistent");
node.status({ fill: "green", shape: "dot", text: `${entries.length} chaves; próxima ${entries[0]?.expires_at.slice(0, 10) ?? "—"}` });
return null;
