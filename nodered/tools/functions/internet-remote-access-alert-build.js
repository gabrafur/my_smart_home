msg._global_observer_test = msg._internet_test === true;
msg.payload = {
    test_mode: msg._internet_test === true,
    observer_kind: "domain_alert",
    incident_key: "remote_access_ssh_unavailable",
    reason: String(msg.remote_access_state?.reason ?? "ssh_unavailable")
};
msg.alert = {
    title: "Acesso remoto ao Raspberry indisponível",
    message: "A internet está online, mas o acesso SSH ou o App Server do Codex não ficou pronto após a confirmação configurada. A recuperação automática do Codex foi solicitada quando segura. O Tailscale é tratado separadamente no fluxo monitoramento_vpn."
};
delete msg.error;
return msg;
