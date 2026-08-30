const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    external_call_sent: false,
    notification_sent: false,
    observer_kind: msg.payload?.observer_kind ?? "unknown",
    completed_at: Date.now()
};
flow.set("global_flow_observer_last_dry_run_v1", result);
node.status({
    fill: "blue",
    shape: "dot",
    text: `TESTE ${result.observer_kind}: push bloqueado`
});
return null;
