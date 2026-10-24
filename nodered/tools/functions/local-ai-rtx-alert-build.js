const reason = String(msg.rtx_status?.reason || "unknown");
const testMode = msg.test_mode === true;
if (!testMode) flow.set("local_ai_rtx_alert_incident_open_v1", true, "persistent");
msg._global_observer_test = testMode;
msg.payload = {
    test_mode: testMode,
    observer_kind: "domain_alert",
    incident_key: "local_ai_rtx_unavailable",
    mobile_notification: false,
    reason,
};
msg.alert = {
    title: "RTX indisponível",
    message: "A conexão da RTX está indisponível. O Node-RED verifica o computador e pode reparar somente o proxy, com tentativas limitadas. Veja a aba recuperacao_rtx para o resultado; VPN, WSL e serviços compartilhados não são reiniciados automaticamente.",
};
delete msg.error;
delete msg.observer_alert;
return msg;
