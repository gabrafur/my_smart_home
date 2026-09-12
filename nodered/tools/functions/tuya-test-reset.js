for (const key of ["tuya_device_incidents_v1__test", "tuya_device_observations_v1__test",
    "tuya_device_monitor_summary_v1__test", "tuya_last_dry_run_v1__test"]) flow.set(key, undefined);
node.status({ fill: "blue", shape: "dot", text: "estado sintético resetado" });
return null;
