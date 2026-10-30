if (msg._host_observer_test !== true) return null;
const name = msg.payload;
const runId = msg._host_test_run_id;
if (runId !== undefined && (typeof runId !== "string" || !/^[a-f0-9]{32}$/.test(runId))) return null;
if (!["reset", "healthy", "failure", "confirm", "resource_high", "source_failure", "stale", "malformed", "legacy"].includes(name)) return null;
if (name === "reset") {
    for (const key of ["host_observer_cursor_v1__test", "host_observer_incidents_v1__test", "host_observer_fixture_v1__test", "host_observer_timing_v1__test"]) flow.set(key, undefined);
    flow.set("host_observer_timing_runtime_v1__test", undefined, "memoryOnly");
    if (runId !== undefined) flow.set("host_observer_fixture_v1__test",
        {now: Date.now(), sequence: 0, action: "started", cpu: 10, run_id: runId});
    node.status({fill: "blue", shape: "dot", text: "somente TESTE resetado"});
    return null;
}
const state = flow.get("host_observer_fixture_v1__test") ?? {now: Date.now(), sequence: 0, action: "started", cpu: 10};
if (state.run_id !== runId) return null;
state.base_now ??= state.now;
if (name === "legacy") {
    const key = "host_observer_incidents_v1__test";
    const ledger = flow.get(key) ?? {version: 1, incidents: {}};
    ledger.incidents["native_docker_ai-bridge"] = {
        kind: "native", first_seen_at: state.now - 20000,
        last_seen_at: state.now - 10000, notified_at: state.now - 30000,
        current_evidence: "failed", source_time_kind: "producer_occurrence",
        source_first_observed_at: new Date(state.now - 20000).toISOString(),
        sample_count: 0, last_sample_at: null
    };
    flow.set(key, ledger);
}
state.sample_sequence = (state.sample_sequence ?? 0) + 1;
state.source_faults ??= 0;
if (name === "source_failure" && state.last_source_state !== "unknown") state.source_faults++;
state.last_source_state = name === "source_failure" ? "unknown" : "connected";
state.now += name === "confirm" ? 25000 : 1000;
if (["failure", "healthy"].includes(name)) {
    state.sequence += 1; state.action = name === "failure" ? "failed" : "started";
}
if (name === "resource_high") state.cpu = 96;
if (name === "healthy") state.cpu = 10;
const at = new Date(state.now).toISOString();
const report = {schema_version: 1, source: "fixed_readonly_host_observer", observed_at: at,
    instance_id: "a".repeat(64), boot_id_sha256: "b".repeat(64), sequence: state.sequence,
    evicted_event_records: 0,
    timing_v1: {version: 1, state: "observed", collection_error: null,
        report_monotonic_seconds: state.now / 1000, resource_sample_sequence: state.sample_sequence,
        resource_sampled_monotonic_seconds: state.now / 1000,
        source_event_counts: {docker: 0, systemd: state.sequence},
        source_fault_counts: {docker: 0, systemd: state.source_faults}, clock_change_count: 0, clock_stable: true,
        resource_period_seconds: 20, idle_report_period_seconds: 10},
    sources: {docker: {state: "connected", collection_error: null}, systemd: {state: name === "source_failure" ? "unknown" : "connected", collection_error: name === "source_failure" ? "stream_unavailable_or_invalid" : null}},
    events: state.sequence ? [{id: state.sequence.toString(16).padStart(64, "0"), source: "systemd", service: "procmon", action: state.action,
        sequence: state.sequence, occurred_at: at, observed_at: at, source_to_observer_ms: 0, source_clock_ordered: true, observer_monotonic_seconds: state.now / 1000}] : [],
    resources: {observed_at: at, collection_errors: [], data: {cpu_busy_percent: state.cpu,
        memory_available_bytes: 4096 * 1048576, memory_total_bytes: 8192 * 1048576,
        disk_used_percent: 50, inodes_used_percent: 10, temperature_celsius: 50, oom_kill_count: 0}}};
if (name === "stale") report.observed_at = new Date(state.now - 120000).toISOString();
flow.set("host_observer_fixture_v1__test", state);
return {_host_observer_test: true, _host_test_now: state.now,
    _host_test_run_id: runId, _host_test_canvas_monotonic_ms: state.now - state.base_now,
    payload: name === "malformed" ? "{" : {schema_version: 1, collection_error: null, report, consumer_clock: {version: 1, state: "observed", collection_error: null,
        observed_at: at, monotonic_seconds: state.now / 1000, boot_id_sha256: "b".repeat(64)}}};
