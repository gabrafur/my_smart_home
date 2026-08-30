const TEST_MODE = msg._vpn_test === true || msg.payload?.test_mode === true;
const suffix = TEST_MODE ? "__test" : "";
const STORE = TEST_MODE ? undefined : "persistent";
const now = Number(msg.vpn_now ?? Date.now());
const get = (key) => STORE ? flow.get(`${key}${suffix}`, STORE) : flow.get(`${key}${suffix}`);
const set = (key, value) => STORE ? flow.set(`${key}${suffix}`, value, STORE) : flow.set(`${key}${suffix}`, value);
const EXPECTED = [{ role: "vpn_primary", kind: "tailscale", label: "Tailscale" }];
const FAILURE_CONFIRM_MS = 2 * 60 * 1000;
const RECOVERY_CONFIRM_MS = 60 * 1000;
const REPORT_STALE_MS = 3 * 60 * 1000;
const REMINDER_MS = 24 * 60 * 60 * 1000;

const report = get("vpn_monitor_report_v1") ?? { checked_at: null, received_at: 0, vpns: [] };
const internet = get("vpn_monitor_internet_v1") ?? { phase: "unknown" };
const states = get("vpn_monitor_state_v1") ?? {};
const reportCheckedAt = Date.parse(report.checked_at ?? "");
const reportFresh = Number.isFinite(reportCheckedAt) && now - reportCheckedAt <= REPORT_STALE_MS;
const samples = new Map((report.vpns ?? []).map((vpn) => [vpn.role, vpn]));
const internetOnline = internet.phase === "online";
const down = [];
const recovery = [];
const publications = [];

const reasonText = {
    authentication_required: "a VPN requer nova autenticação",
    backend_stopped: "o serviço da VPN está parado",
    backend_unavailable: "o backend da VPN não está operacional",
    status_command_failed: "a consulta local de estado falhou",
    status_timeout: "a consulta local de estado excedeu o tempo limite",
    invalid_status: "o serviço retornou estado inválido",
    vpn_not_detected: "a VPN instalada não foi detectada pelo publicador",
    telemetry_stale: "o monitor do host deixou de atualizar o estado",
    not_online: "a VPN não está conectada"
};

for (const expected of EXPECTED) {
    const previous = states[expected.role] ?? {
        phase: "checking",
        incident_open: false,
        failure_started_at: null,
        recovery_started_at: null,
        last_notification_at: null
    };
    const sample = samples.get(expected.role);
    const healthy = reportFresh && sample?.healthy === true;
    const failureReason = !reportFresh
        ? "telemetry_stale"
        : sample
            ? String(sample.reason ?? "not_online")
            : "vpn_not_detected";
    const current = { ...previous, kind: expected.kind, label: expected.label };

    if (!internetOnline) {
        current.phase = "suppressed_internet";
        current.failure_started_at = null;
        current.recovery_started_at = null;
        current.reason = `internet_${internet.phase ?? "unknown"}`;
    } else if (!healthy) {
        current.recovery_started_at = null;
        current.reason = failureReason;
        if (!Number.isFinite(current.failure_started_at)) current.failure_started_at = now;
        const confirmed = now - current.failure_started_at >= FAILURE_CONFIRM_MS;
        current.phase = confirmed ? "offline" : "checking";
        const reminderDue =
            current.incident_open === true &&
            now - Number(current.last_notification_at ?? now) >= REMINDER_MS;
        if (confirmed && (current.incident_open !== true || reminderDue)) {
            current.incident_open = true;
            current.last_notification_at = now;
            current.last_outage_at = current.last_outage_at ?? new Date(current.failure_started_at).toISOString();
            down.push({
                _vpn_test: TEST_MODE,
                _vpn_side_effect: "notification",
                payload: { test_mode: TEST_MODE, observer_kind: "vpn_unavailable", vpn_role: expected.role },
                notification: {
                    id: `vpn_${expected.role}_failure`,
                    title: TEST_MODE ? `TESTE — VPN ${expected.label} indisponível` : `VPN ${expected.label} indisponível`,
                    message:
                        `A internet está disponível, mas a VPN ${expected.label} permanece ` +
                        `fora do ar há pelo menos 2 minutos: ${reasonText[failureReason] ?? reasonText.not_online}.`
                }
            });
        }
    } else {
        current.failure_started_at = null;
        current.reason = "running";
        if (current.incident_open === true) {
            if (!Number.isFinite(current.recovery_started_at)) current.recovery_started_at = now;
            if (now - current.recovery_started_at >= RECOVERY_CONFIRM_MS) {
                current.phase = "online";
                current.incident_open = false;
                current.last_recovery_at = new Date(now).toISOString();
                current.last_outage_at = null;
                current.last_notification_at = null;
                current.recovery_started_at = null;
                recovery.push({
                    _vpn_test: TEST_MODE,
                    _vpn_side_effect: "notification",
                    payload: { test_mode: TEST_MODE, observer_kind: "vpn_recovered", vpn_role: expected.role },
                    notification: {
                        id: `vpn_${expected.role}_recovered`,
                        dismiss_id: `vpn_${expected.role}_failure`,
                        title: TEST_MODE ? `TESTE — VPN ${expected.label} recuperada` : `VPN ${expected.label} recuperada`,
                        message: `A VPN ${expected.label} voltou a ficar online e permaneceu estável por 1 minuto.`
                    }
                });
            } else {
                current.phase = "recovering";
            }
        } else {
            current.phase = "online";
            current.recovery_started_at = null;
        }
    }

    current.last_checked_at = report.checked_at ?? null;
    states[expected.role] = current;
    const online = current.phase === "online" || current.phase === "recovering";
    const attributes = {
        state: current.phase,
        reason: current.reason,
        internet_state: internet.phase ?? "unknown",
        last_checked_at: current.last_checked_at,
        last_outage: current.last_outage_at ?? null,
        last_recovery: current.last_recovery_at ?? null
    };
    publications.push(
        { topic: `nodered/infrastructure/vpn/${expected.role}/connection`, payload: online ? "ON" : "OFF" },
        { topic: `nodered/infrastructure/vpn/${expected.role}/state`, payload: current.phase },
        { topic: `nodered/infrastructure/vpn/${expected.role}/attributes`, payload: JSON.stringify(attributes) }
    );
}

set("vpn_monitor_state_v1", states);
const phases = Object.values(states).map((state) => state.phase);
node.status({
    fill: phases.every((phase) => phase === "online") ? "green" : phases.some((phase) => phase === "offline") ? "red" : "yellow",
    shape: phases.every((phase) => phase === "online") ? "dot" : "ring",
    text: phases.join(", ") || "sem VPN configurada"
});

const wrapPublications = publications.map((publication) => ({
    _vpn_test: TEST_MODE,
    _vpn_side_effect: "mqtt",
    _vpn_payload_meta: { test_mode: TEST_MODE, observer_kind: "vpn_mqtt" },
    topic: publication.topic,
    payload: publication.payload
}));
return [down.length ? down : null, recovery.length ? recovery : null, wrapPublications.length ? wrapPublications : null];
