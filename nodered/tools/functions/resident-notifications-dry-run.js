const input = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const result = {
    version: 1,
    simulated: true,
    dispatched: false,
    source: input.source,
    recipient: input.recipient,
    message: input.message,
    completed_at: Date.now()
};
flow.set("resident_notifications_last_dry_run_v1__test", result);
node.status({ fill: "blue", shape: "dot", text: "TESTE: aviso simulado; nenhum push" });
node.warn("RESIDENT_NOTIFICATION_DRY_RUN_COMPLETE source=" + String(result.source) +
    " recipient=" + String(result.recipient) + " dispatched=false");
return null;
