const value = msg.payload;
const bounds = {
    max_report_age_ms: [10000, 60000], max_resource_age_ms: [20000, 60000],
    event_confirm_ms: [1000, 60000], resource_confirm_ms: [20000, 120000],
    observation_confirm_ms: [10000, 120000], cpu_busy_percent: [50, 100],
    memory_available_mib: [128, 2048], disk_used_percent: [70, 95],
    inodes_used_percent: [70, 95], temperature_celsius: [60, 90]
};
if (!value || Object.keys(value).length !== Object.keys(bounds).length ||
    !Object.entries(bounds).every(([key, [min, max]]) =>
        Number.isFinite(value[key]) && value[key] >= min && value[key] <= max)) {
    node.status({fill: "red", shape: "ring", text: "política rejeitada; anterior preservada"});
    return null;
}
flow.set("host_observer_policy_v1", {...value}, "persistent");
node.status({fill: "green", shape: "dot", text: "política visual válida"});
return null;
