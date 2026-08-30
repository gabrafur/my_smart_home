for (const key of [
    "vpn_monitor_report_v1__test",
    "vpn_monitor_internet_v1__test",
    "vpn_monitor_state_v1__test",
    "vpn_monitor_last_dry_run_v1"
]) flow.set(key, undefined);
flow.set("vpn_monitor_last_dry_run_v1", {
    version: 1,
    reset: true,
    simulated: true,
    dispatched: false,
    events: [],
    completed_at: Date.now()
});
node.status({ fill: "grey", shape: "ring", text: "estado de teste resetado" });
return null;
