const { current, report, internet, test_mode: testMode } = msg.vpn;
current.last_checked_at = report.checked_at ?? null;
const online = current.phase === "online" || current.phase === "recovering";
const attributes = {
    state: current.phase, reason: current.reason,
    internet_state: internet.phase ?? "unknown",
    last_checked_at: current.last_checked_at,
    last_outage: current.last_outage_at ?? null,
    last_recovery: current.last_recovery_at ?? null
};
const publications = [
    [`nodered/infrastructure/vpn/vpn_primary/connection`, online ? "ON" : "OFF"],
    [`nodered/infrastructure/vpn/vpn_primary/state`, current.phase],
    [`nodered/infrastructure/vpn/vpn_primary/attributes`, JSON.stringify(attributes)]
].map(([topic, payload]) => ({
    _vpn_test: testMode, _vpn_side_effect: "mqtt",
    _vpn_payload_meta: { test_mode: testMode, observer_kind: "vpn_mqtt" }, topic, payload
}));
node.status({
    fill: current.phase === "online" ? "green" : current.phase === "offline" ? "red" : "yellow",
    shape: current.phase === "online" ? "dot" : "ring", text: current.phase
});
return [publications];
