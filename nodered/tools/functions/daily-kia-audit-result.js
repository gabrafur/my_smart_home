const TEST_MODE = msg._kia_update_test === true || msg.payload?.test_mode === true;
const text = String(msg.payload ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 700);
if (!text) return null;
const status = text.match(/\bstatus=(running|compatible|conflict|applied|rollback|failed|deferred|unavailable|unknown)\b/)?.[1];
if (!status) {
    if (!TEST_MODE) node.error("kia_uvo_update_result_unrecognized", msg);
    return null;
}
const reasons = {
    connect_timeout: "O tempo de conexão com a fonte da auditoria foi excedido.",
    transport_timeout: "A comunicação da auditoria excedeu o tempo disponível.",
    dns_resolution_failed: "A auditoria não conseguiu resolver um nome de rede.",
    connection_failed: "A conexão de rede da auditoria falhou.",
    tls_verification_failed: "A verificação TLS da auditoria falhou.",
    audit_failed_unclassified: "O produtor não registrou um motivo diagnóstico seguro.",
    invalid_request: "A solicitação não passou pela validação do worker."
};
const rawReason = text.match(/\breason=([a-z_]+)\b/)?.[1];
const reason = Object.hasOwn(reasons, rawReason) ? rawReason : "audit_failed_unclassified";
const result = {
    version: 1, status,
    request_id: text.match(/\brequest_id=([^ ]+)\b/)?.[1] ?? "unknown",
    mode: text.match(/\bmode=(audit|install)\b/)?.[1] ?? "audit",
    installed_version: text.match(/\binstalled_version=([^ ]+)\b/)?.[1] ?? null,
    latest_version: text.match(/\blatest_version=([^ ]+)\b/)?.[1] ?? null,
    patch_state: text.match(/\bpatch_state=([^ ]+)\b/)?.[1] ?? null,
    conflicts: Number(text.match(/\bconflicts=(\d+)\b/)?.[1] ?? 0),
    checked_at: text.match(/\bchecked_at=([^ ]+)\b/)?.[1] ?? null,
    reason, test_mode: TEST_MODE, observed_at: Date.now()
};
const signature = [result.request_id, result.status, result.latest_version, result.checked_at].join(":");
const key = TEST_MODE ? "kia_uvo_update_last_result_v1__test" : "kia_uvo_update_last_result_v1";
const previous = TEST_MODE ? flow.get(key) : flow.get(key, "persistent");
if (previous?.signature === signature) return null;
result.signature = signature;
const failed = ["failed", "unavailable", "rollback"].includes(status);
const completed = ["compatible", "conflict", "applied"].includes(status);
const now = result.observed_at;
const previousAlert = Number(previous?.failure_alert_at);
const validAlert = Number.isFinite(previousAlert) && previousAlert > 0 && previousAlert <= now;
result.failure_alert_at = validAlert ? previousAlert : null;
result.audit_incident_open = previous?.audit_incident_open === true;
const priorFailure = Number(previous?.audit_failure_observed_at);
result.audit_failure_observed_at = Number.isFinite(priorFailure) && priorFailure > 0 ? priorFailure : null;
if (failed) result.audit_failure_observed_at = now;
const checkedAt = typeof result.checked_at === "string" ? Date.parse(result.checked_at) : NaN;
const freshCompleted = completed && /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(result.latest_version ?? "") &&
    Number.isFinite(checkedAt) && checkedAt <= now && checkedAt > Number(result.audit_failure_observed_at);
let alert = null;
if (failed && (!validAlert || now - previousAlert >= 6 * 60 * 60 * 1000)) {
    result.failure_alert_at = now;
    result.audit_incident_open = true;
    alert = {
        _global_observer_test: TEST_MODE,
        payload: {
            test_mode: TEST_MODE, observer_kind: "domain_alert",
            incident_key: "kia_uvo_update_audit", reason,
            source_id: "daily_update_kia_parse_result", flow_id: "daily_host_updates_tab"
        },
        alert: {
            title: "Verificação da integração veicular não concluída",
            message: reasons[reason] + " Resultado do worker: " + status +
                ". A solicitação não será repetida automaticamente. Consulte o resultado da auditoria antes de solicitar outra tentativa."
        }
    };
} else if (freshCompleted && result.audit_incident_open) {
    result.audit_incident_open = false;
    alert = {
        _global_observer_test: TEST_MODE,
        payload: {
            test_mode: TEST_MODE, observer_kind: "domain_recovery",
            persistent_incident_kind: "domain_alert",
            persistent_notification_operation: "dismiss", mobile_notification: false,
            incident_key: "kia_uvo_update_audit", resolution: "later_audit_completed"
        },
        alert: { title: "Verificação da integração veicular concluída",
            message: "Uma verificação posterior terminou. Este encerramento se refere à auditoria e não comprova a saúde de todos os serviços." }
    };
}
// Persist deduplication and incident state before handing any effect onward.
if (TEST_MODE) flow.set(key, result);
else flow.set(key, result, "persistent");
node.status({
    fill: failed ? "red" : completed ? "green" : "blue",
    shape: failed || status === "conflict" ? "ring" : "dot",
    text: status === "conflict" ? "v" + String(result.latest_version ?? "?") + ": conflito; preservado" : status
});
if (TEST_MODE) { msg.payload = result; return [msg, null, alert]; }
if (["compatible", "conflict"].includes(status) && result.mode === "install") {
    if (status === "conflict") node.warn("kia_uvo_update_requires_codex_merge latest=" + String(result.latest_version));
    if (!result.latest_version) {
        node.error("kia_uvo_codex_merge_missing_target", msg);
        return [null, null, alert];
    }
    msg.payload = result.latest_version;
    msg.kia_uvo_update = result;
    return [null, msg, alert];
}
return [null, null, alert];
