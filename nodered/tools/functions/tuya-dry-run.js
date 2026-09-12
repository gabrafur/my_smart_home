const result = {
    simulated: true,
    dispatched: false,
    effect: msg.notification ? "notification" : "mqtt",
    phase: msg.tuya_phase || null,
    recorded_at: new Date(msg.tuya_now ?? msg.monitor_now ?? Date.now()).toISOString()
};
flow.set("tuya_last_dry_run_v1__test", result);
node.status({ fill: "blue", shape: "dot", text: "TESTE: efeito bloqueado" });
return null;
