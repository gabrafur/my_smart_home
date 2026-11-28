// Daily decision: warn before a Tailscale key logs a device out; dismiss the
// warning once the key was renewed or its expiry disabled.
const TEST = msg._ha_updates_test === true;
const read = (key) => TEST ? flow.get(key + "__test") : flow.get(key, "persistent");
const write = (key, value) => TEST ? flow.set(key + "__test", value) : flow.set(key, value, "persistent");
const DAY = 86400000;

const policy = msg.vpn_key_policy ?? {};
const days = Array.isArray(policy.notify_days)
    ? [...new Set(policy.notify_days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 60))].sort((a, b) => a - b)
    : [];
const maxAgeHours = Number.isInteger(policy.report_max_age_hours) && policy.report_max_age_hours >= 1 && policy.report_max_age_hours <= 168
    ? policy.report_max_age_hours : null;
if (!days.length || maxAgeHours === null) {
    node.status({ fill: "red", shape: "ring", text: "política inválida; nada decidido" });
    return null;
}

const now = Number(msg.monitor_now ?? Date.now());
const report = TEST ? msg.vpn_key_report : read("vpn_key_expiry_report_v1");
const checkedAt = Date.parse(report?.checked_at ?? "");
if (!Array.isArray(report?.entries) || !Number.isFinite(checkedAt) || now - checkedAt > maxAgeHours * 3600000) {
    // Stale telemetry belongs to monitoramento_vpn; never dismiss on missing data.
    node.status({ fill: "yellow", shape: "ring", text: "sem relatório recente; aguardando" });
    return null;
}

function incidentFor(entry) {
    let hash = 2166136261;
    for (const c of [entry.scope, entry.platform, entry.shared, entry.expires_at].join("|")) {
        hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
    }
    return "vpn_key_expiry_" + hash.toString(16).padStart(8, "0");
}
function dateText(ms) {
    try {
        return new Date(ms).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
    } catch {
        return new Date(ms).toISOString().slice(0, 10);
    }
}
const PLATFORM = {
    ios: "do iPhone/iPad", android: "do Android", windows: "do PC Windows",
    macos: "do Mac", linux: "de um aparelho Linux", other: "de um aparelho"
};
function describe(entry, expiresAt) {
    const left = expiresAt - now;
    const daysLeft = Math.floor(left / DAY);
    const when = left <= 0 ? "venceu em " + dateText(expiresAt)
        : daysLeft === 0 ? "vence hoje (" + dateText(expiresAt) + ")"
        : daysLeft === 1 ? "vence amanhã (" + dateText(expiresAt) + ")"
        : "vence em " + daysLeft + " dias (" + dateText(expiresAt) + ")";
    const who = entry.scope === "host" ? "do Raspberry Pi (servidor da casa)"
        : entry.shared ? "de um aparelho compartilhado de outra conta"
        : PLATFORM[entry.platform] ?? PLATFORM.other;
    const effect = entry.scope === "host"
        ? "Quando vencer, todo o acesso remoto à casa para: app do Home Assistant fora de casa, Eva e Claude."
        : "Quando vencer, esse aparelho é deslogado da VPN e o app do Home Assistant deixa de conectar fora de casa.";
    const fix = entry.shared
        ? "O dono desse aparelho precisa entrar de novo no app do Tailscale ou desativar o vencimento na conta dele."
        : "Para evitar: login.tailscale.com → Machines → ⋯ → Disable key expiry, ou entre de novo no app do Tailscale.";
    return {
        title: left <= 0 ? "VPN: chave do Tailscale venceu" : "VPN: chave do Tailscale " + when.replace(/ \(.*\)$/, ""),
        message: "A chave do Tailscale " + who + " " + when + ". " + effect + " " + fix,
        expired: left <= 0
    };
}

const previous = read("vpn_key_expiry_notices_v1") ?? {};
const state = {};
const out = [];
const base = (incident, reason) => ({
    observer_kind: "domain_alert",
    persistent_incident_kind: "domain_alert",
    persistent_notification_operation: "create",
    mobile_notification: true,
    incident_key: incident,
    test_mode: TEST,
    reason,
    source_observed_at: checkedAt,
    source_time_kind: "native",
    policy_decided_at: now
});

for (const entry of report.entries) {
    const expiresAt = Date.parse(entry.expires_at);
    const daysLeft = Math.floor((expiresAt - now) / DAY);
    const bucket = days.find((d) => Math.max(daysLeft, 0) <= d);
    if (bucket === undefined) continue;
    const incident = incidentFor(entry);
    state[incident] = { bucket, expires_at: entry.expires_at };
    if (previous[incident]?.bucket === bucket) continue;
    const text = describe(entry, expiresAt);
    out.push({
        ...msg,
        payload: base(incident, text.expired ? "vpn_key_expired" : "vpn_key_expiring"),
        alert: { title: text.title, message: text.message }
    });
}
for (const incident of Object.keys(previous)) {
    if (state[incident]) continue;
    out.push({
        ...msg,
        payload: {
            ...base(incident, "vpn_key_renewed"),
            observer_kind: "domain_recovery",
            persistent_notification_operation: "dismiss",
            mobile_notification: false
        },
        alert: { title: "VPN: chave do Tailscale renovada", message: "A chave que estava para vencer foi renovada ou deixou de vencer." }
    });
}
write("vpn_key_expiry_notices_v1", state);
const open = Object.keys(state).length;
node.status({
    fill: open ? "yellow" : "green", shape: "dot",
    text: (open ? open + " chave(s) perto de vencer" : "nenhuma chave perto de vencer") + (TEST ? " (TESTE)" : "")
});
return [out];
