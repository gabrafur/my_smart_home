const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    service: "ssh",
    event: msg.remote_access_event ?? "probe",
    phase: msg.remote_access_state?.phase ?? "unknown",
    completed_at: Date.now()
};
flow.set("internet_remote_access_last_dry_run_v1__test", result);
node.status({ fill: "blue", shape: "dot", text: `TESTE SSH: ${result.event} bloqueado` });
return null;
