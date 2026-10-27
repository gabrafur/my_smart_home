// Measurement only: every normalized receipt continues to the existing gates.
const test = msg._host_observer_test === true;
const suffix = test ? "__test" : "";
const store = test ? undefined : "persistent";
const key = "host_observer_timing_v1" + suffix;
const runtimeKey = "host_observer_timing_runtime_v1" + suffix;
const origin = timingClock.performance.timeOrigin;
const previous = flow.get(key, store);
const result = hostTimingTransition(previous, {
    report: msg._host_report_valid ? msg._host_report : null,
    reader: msg._host_consumer_clock,
    now_ms: msg._host_now,
    canvas_monotonic_ms: test ? msg._host_test_canvas_monotonic_ms : timingClock.performance.now(),
    limits: flow.get("host_observer_timing_policy_v1", "persistent"),
    max_report_age_ms: msg._host_policy.max_report_age_ms,
    runtime_restarted: flow.get(runtimeKey, "memoryOnly") !== origin
});
flow.set(key, result, store);
flow.set(runtimeKey, origin, "memoryOnly");
return msg;
