const value = msg.payload;
const bounds = {
    max_report_age_ms: [10000, 60000], max_resource_age_ms: [20000, 60000],
    event_confirm_ms: [1000, 60000], resource_confirm_ms: [20000, 120000],
    observation_confirm_ms: [10000, 120000], stop_confirm_ms: [60000, 900000],
    crash_loop_stops: [2, 10], crash_loop_window_ms: [300000, 3600000], cpu_busy_percent: [50, 100],
    memory_available_mib: [128, 2048], disk_used_percent: [70, 95],
    inodes_used_percent: [70, 95], temperature_celsius: [60, 90]
};
if (!value || Object.keys(value).length !== Object.keys(bounds).length ||
    !Object.entries(bounds).every(([key, [min, max]]) =>
        Number.isFinite(value[key]) && value[key] >= min && value[key] <= max)) {
    node.status({fill: "red", shape: "ring", text: "política rejeitada; anterior preservada"});
    return null;
}
// The MCP reader (health_summary.py) accepts exactly the ten visual keys in
// host_observer_policy_v1; the stop/crash-loop window lives in its own key so
// the root-pinned reader keeps validating the visual policy.
const LIFECYCLE = ["stop_confirm_ms", "crash_loop_stops", "crash_loop_window_ms"];
const visual = Object.fromEntries(Object.keys(bounds).filter((key) => !LIFECYCLE.includes(key)).map((key) => [key, value[key]]));
const lifecycle = Object.fromEntries(LIFECYCLE.map((key) => [key, value[key]]));
flow.set("host_observer_policy_v1", visual, "persistent");
flow.set("host_observer_lifecycle_policy_v1", lifecycle, "persistent");
node.status({fill: "green", shape: "dot", text: "política visual válida"});
return null;
