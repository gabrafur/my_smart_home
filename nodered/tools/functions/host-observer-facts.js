const test = msg._host_observer_test === true;
const store = test ? undefined : "persistent";
const key = test ? "host_observer_cursor_v1__test" : "host_observer_cursor_v1";
const previous = flow.get(key, store);
const report = msg._host_report;
const services = {
    docker: ["homeassistant", "nodered", "mosquitto", "portainer", "appdaemon", "matter_server",
        "zigbee2mqtt", "ai-bridge", "docs-review-scheduler", "kia-uvo-codex-merge"],
    systemd: ["docker", "procmon", "mcp_collection", "external_heartbeat", "events", "ha_notices", "host_observation"]
};
const actions = {
    docker: ["start", "die", "restart", "destroy", "health_status: healthy", "health_status: unhealthy", "health_status: starting"],
    systemd: ["started", "stopped", "failed"]
};
const native = previous?.instance === report.instance_id && previous.sequence <= report.sequence
    ? previous : {instance: report.instance_id, sequence: report.sequence, states: {}, baseline_only: true};
if (!native.states || typeof native.states !== "object") native.states = {};
native.source_gaps ??= {};
const reportGap = Number.isFinite(native.last_report_at) &&
    msg._host_now - native.last_report_at > msg._host_policy.max_report_age_ms;
for (const source of ["docker", "systemd"]) {
    const connected = report.sources[source]?.state === "connected" && report.sources[source]?.collection_error === null;
    if (!connected) native.source_gaps[source] = true;
    else if (native.source_gaps[source] || reportGap) {
        for (const row of Object.values(native.states)) if (row.source === source) row.action = "unknown";
        native.source_gaps[source] = false;
        native.coverage_gap = true;
    }
}
native.last_report_at = msg._host_now;
const first = report.events[0]?.sequence;
if (Number.isSafeInteger(first) && native.sequence < first - 1) native.coverage_gap = true;
for (const event of report.events) {
    if (!event || typeof event !== "object") continue;
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= native.sequence || event.sequence > report.sequence) continue;
    if (!services[event.source]?.includes(event.service) || !actions[event.source]?.includes(event.action)) continue;
    const at = Date.parse(event.occurred_at);
    if (!Number.isFinite(at) || at > msg._host_now + 1000) continue;
    native.states[`${event.source}:${event.service}`] = {kind: "native", name: event.service,
        source: event.source, action: event.action, occurred_at: event.occurred_at};
}
native.sequence = report.sequence;
flow.set(key, native, store);
const facts = [{kind: "observation", name: "report", state: "connected"}];
for (const source of ["docker", "systemd"]) {
    const connected = report.sources[source]?.state === "connected" && report.sources[source]?.collection_error === null;
    facts.push({kind: "observation", name: source, state: connected ? "connected" : "unknown"});
    for (const fact of Object.values(native.states).filter(row => row.source === source)) {
        facts.push({...fact, action: connected ? fact.action : "unknown"});
    }
}
const metrics = {cpu: "cpu_busy_percent", memory: "memory_available_bytes", disk: "disk_used_percent",
    inodes: "inodes_used_percent", temperature: "temperature_celsius"};
const resource = report.resources;
facts.push({kind: "observation", name: "resources", state: msg._host_resources_fresh &&
    Array.isArray(resource.collection_errors) && resource.collection_errors.length === 0 ? "connected" : "unknown"});
for (const [name, metric] of Object.entries(metrics)) {
    const value = resource.data[metric];
    const valid = msg._host_resources_fresh && Number.isFinite(value) && value >= 0 &&
        (!resource.collection_errors?.includes(metric));
    facts.push({kind: "resource", name, value: valid ? name === "memory" ? value / 1048576 : value : null,
        observed_at: valid ? resource.observed_at : null});
}
// OOM is a counter, not proof that a particular process or service died.
const oom = resource.data.oom_kill_count;
if (msg._host_resources_fresh && Number.isSafeInteger(oom) && oom >= 0) {
    if (previous?.instance === report.instance_id && Number.isSafeInteger(previous.oom) && oom > previous.oom) {
        native.oom_incident = {kind: "native", name: "host_oom", source: "kernel_counter", action: "oom_increment",
            occurred_at: resource.observed_at};
    }
    native.oom = oom; flow.set(key, native, store);
}
if (native.oom_incident) facts.push(native.oom_incident);
return [facts.map(fact => ({_host_observer_test: test, _host_now: msg._host_now,
    _host_policy: msg._host_policy, _host_fact: fact}))];
