if (!(msg._global_observer_test === true || msg.payload?.test_mode === true) ||
    msg._observer_delivery_test === true) return null;
const trace = msg._observer_test_receipt;
if (trace !== undefined && (!trace || typeof trace !== "object" || Array.isArray(trace) ||
    Object.keys(trace).length !== 2 || typeof trace.run_id !== "string" ||
    !/^[a-f0-9]{32}$/.test(trace.run_id) || trace.source_flow_id !== "host_observer_tab")) return null;
const previous = flow.get("global_flow_observer_last_dry_run_v1");
const sequence = Number.isSafeInteger(previous?.receipt_sequence) && previous.receipt_sequence >= 0
    ? previous.receipt_sequence : 0;
if (sequence === Number.MAX_SAFE_INTEGER) return null;
const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    external_call_sent: false,
    notification_sent: false,
    observer_kind: msg.payload?.observer_kind ?? "unknown",
    receipt_sequence: sequence + 1,
    run_id: trace?.run_id ?? null,
    source_flow_id: trace?.source_flow_id ?? null,
    completed_at: Date.now()
};
flow.set("global_flow_observer_last_dry_run_v1", result);
node.status({
    fill: "blue",
    shape: "dot",
    text: `TESTE ${result.observer_kind}: push bloqueado`
});
return null;
