flow.set("host_memory_guardian_last_result_v1__test", undefined);
flow.set("host_memory_guardian_last_dry_run_v1", {
    version: 1,
    status: "reset",
    simulated: true,
    dispatched: false,
    completed_at: Date.now()
});
node.status({ fill: "grey", shape: "ring", text: "estado de teste resetado" });
return null;
