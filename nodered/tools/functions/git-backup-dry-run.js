const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    external_call_sent: false,
    notification_sent: false,
    persistent_notification_sent: false,
    status: msg.payload?.status ?? msg.git_backup_status ?? "request_simulated",
    completed_at: Date.now(),
};
flow.set("git_backup_last_dry_run_v1", result);
msg.payload = result;
node.status({ fill: result.status === "failed" ? "yellow" : "green", shape: "dot", text: "TESTE: " + result.status + "; efeitos bloqueados" });
node.warn("GIT_BACKUP_DRY_RUN " + JSON.stringify(result));
return null;
