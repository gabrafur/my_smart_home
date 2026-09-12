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
const { current, now, test_mode: testMode, failure_reason: reason } = msg.vpn;
current.incident_open = true;
current.last_notification_at = now;
current.last_outage_at = current.last_outage_at ?? new Date(current.failure_started_at).toISOString();
const notification = {
    ...msg, _vpn_test: testMode, _vpn_side_effect: "notification",
    payload: { test_mode: testMode, observer_kind: "vpn_unavailable", vpn_role: "vpn_primary" },
    notification: {
        id: "vpn_vpn_primary_failure",
        title: testMode ? "TESTE — VPN Tailscale indisponível" : "VPN Tailscale indisponível",
        message: `A internet está disponível, mas a VPN Tailscale permanece fora do ar há pelo menos ${msg.policy.failure_confirm_s} segundos: ${reasonText[reason] ?? reasonText.not_online}.`
    }
};
return [notification, msg];
