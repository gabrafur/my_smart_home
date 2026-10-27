const DRY_RUN_CONTRACT = { simulated: true, dispatched: false };
const result = msg.notification_delivery ?? {};
if (result.simulated !== DRY_RUN_CONTRACT.simulated || result.dispatched !== DRY_RUN_CONTRACT.dispatched) {
    node.error("notification_hub: terminal recebeu efeito não simulado", msg);
    return null;
}
node.status({ fill: "green", shape: "dot", text: `dry-run ${String(result.channel ?? "unknown")}` });
node.log(`NOTIFICATION_HUB_DRY_RUN channel=${String(result.channel ?? "unknown")} status=${String(result.status ?? "unknown")}`);
// Correlate an explicit native history test without files or persistent context.
// The history serializer supplies only validated timing and an opaque test ID.
if (typeof result.run_id === "string" && /^[a-f0-9]{32}$/.test(result.run_id) &&
    ["mobile", "alexa", "persistent"].includes(result.channel) && result.timing) {
    node.log("NOTIFICATION_HISTORY_TIMING_DRY_RUN " + JSON.stringify({ version: 1,
        run_id: result.run_id, channel: result.channel, timing: result.timing,
        simulated: true, dispatched: false }));
}
return null;
