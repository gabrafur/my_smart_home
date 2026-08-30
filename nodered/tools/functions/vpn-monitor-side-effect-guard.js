const TEST_MODE = msg._vpn_test === true || msg.payload?.test_mode === true || msg._vpn_payload_meta?.test_mode === true;
if (!TEST_MODE) return [msg, null];
msg.payload = {
    test_mode: true,
    observer_kind: msg.payload?.observer_kind ?? msg._vpn_payload_meta?.observer_kind ?? "vpn_side_effect",
    side_effect: msg._vpn_side_effect ?? "unknown",
    simulated: true,
    dispatched: false
};
return [null, msg];
