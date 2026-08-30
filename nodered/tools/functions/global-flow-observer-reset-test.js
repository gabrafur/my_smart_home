flow.set("global_flow_observer_v1__test", undefined);
flow.set("global_flow_observer_last_dry_run_v1", {
    version: 1,
    reset: true,
    simulated: true,
    dispatched: false,
    completed_at: Date.now()
});
node.status({ fill: "grey", shape: "ring", text: "estado de teste resetado" });
return null;
