const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    event: msg.internet_event ?? "state_publication",
    phase: msg.internet_state?.phase ?? String(msg.payload ?? "unknown"),
    topic: msg.topic ?? null,
    completed_at: Date.now()
};
flow.set("internet_monitor_last_dry_run_v1__test", result);
node.status({ fill: "blue", shape: "dot", text: "TESTE: publicação/aviso bloqueado" });
return null;
