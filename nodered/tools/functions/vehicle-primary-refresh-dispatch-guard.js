const TEST_MODE =
    msg._location_test === true ||
    msg.payload?.test_mode === true;

if (TEST_MODE) {
    msg.payload = {
        ...msg.payload,
        side_effect: "vehicle_primary.force_refresh",
        simulated: true,
        dispatched: false,
        dry_run_at: Number(msg.payload?.test_now) || Date.now()
    };
    node.status({
        fill: "blue",
        shape: "dot",
        text: "TESTE: force_refresh bloqueado no dry-run"
    });
    return [null, msg];
}

return [msg, null];
