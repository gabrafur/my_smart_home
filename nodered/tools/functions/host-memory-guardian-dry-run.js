const input = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const result = {
    version: 1,
    status: input.status ?? input.event ?? "request_prepared",
    simulated: true,
    dispatched: false,
    host_request_sent: false,
    signal_sent: false,
    candidate_pid: input.candidate_pid ?? "none",
    candidate_mib: Number(input.candidate_mib ?? 0),
    completed_at: Date.now()
};
flow.set("host_memory_guardian_last_dry_run_v1", result);
node.status({
    fill: "blue",
    shape: "dot",
    text: "TESTE: " + result.status + "; sinais bloqueados"
});
return null;
