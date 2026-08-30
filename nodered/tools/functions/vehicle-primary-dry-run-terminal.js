msg.payload = {
    ...msg.payload,
    test_mode: true,
    simulated: true,
    dispatched: false,
    external_call_sent: false,
    terminal: "vehicle_primary_full_dry_run"
};
flow.set("vehicle_primary_last_dry_run_v1", msg.payload);
node.status({
    fill: "blue",
    shape: "dot",
    text:
        "TESTE dry-run: " +
        String(msg.payload.side_effect ?? "nenhuma ação") +
        " dispatched=false"
});
return null;
