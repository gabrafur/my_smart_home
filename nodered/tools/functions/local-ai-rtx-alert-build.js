const reason = String(msg.rtx_status?.reason || "unknown");
msg._global_observer_test = msg.test_mode === true;
msg.payload = {
    test_mode: msg.test_mode === true,
    observer_kind: "domain_alert",
    incident_key: "local_ai_rtx_unavailable",
    mobile_notification: false,
    reason,
};
msg.alert = {
    title: "RTX indisponível",
    message: "A conexão da RTX está indisponível. A recuperação é manual para não interromper sua VPN: abra a aba recuperacao_rtx e clique em Recuperar endpoint via MCP.",
};
delete msg.error;
delete msg.observer_alert;
return msg;
