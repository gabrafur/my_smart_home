const { current, now, test_mode: testMode } = msg.vpn;
current.phase = "online";
current.incident_open = false;
current.last_recovery_at = new Date(now).toISOString();
current.last_outage_at = null;
current.last_notification_at = null;
current.recovery_started_at = null;
const notification = {
    ...msg, _vpn_test: testMode, _vpn_side_effect: "notification",
    payload: { test_mode: testMode, observer_kind: "vpn_recovered", vpn_role: "vpn_primary" },
    notification: {
        id: "vpn_vpn_primary_recovered", dismiss_id: "vpn_vpn_primary_failure",
        title: testMode ? "TESTE — VPN Tailscale recuperada" : "VPN Tailscale recuperada",
        message: `A VPN Tailscale voltou a ficar online e permaneceu estável por ${msg.policy.recovery_confirm_s} segundos.`
    }
};
return [notification, msg];
