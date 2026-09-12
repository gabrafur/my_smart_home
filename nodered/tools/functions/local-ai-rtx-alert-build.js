const reason = String(msg.rtx_status?.reason || "unknown");
msg._global_observer_test = msg.test_mode === true;
msg._global_observer = {
    flow_id: "local_ai_rtx_recovery_tab",
    flow_label: "recuperacao_rtx",
};
msg.error = {
    message: `RTX indisponível: ${reason}`,
    source: {
        id: "local_ai_rtx_health_evaluate",
        type: "function",
        name: "Monitor de disponibilidade da RTX",
    },
};
msg.observer_alert = {
    title: "RTX indisponível",
    message: "A conexão da RTX está indisponível. A recuperação é manual para não interromper sua VPN: abra a aba recuperacao_rtx e clique em Recuperar endpoint via MCP.",
};
return msg;
