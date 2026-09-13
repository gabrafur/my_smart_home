const DRY_RUN_CONTRACT = { simulated: true, dispatched: false };
const result = msg.notification_delivery ?? {};
if (result.simulated !== DRY_RUN_CONTRACT.simulated || result.dispatched !== DRY_RUN_CONTRACT.dispatched) {
    node.error("notification_hub: terminal recebeu efeito não simulado", msg);
    return null;
}
node.status({ fill: "green", shape: "dot", text: `dry-run ${String(result.channel ?? "unknown")}` });
node.log(`NOTIFICATION_HUB_DRY_RUN channel=${String(result.channel ?? "unknown")} status=${String(result.status ?? "unknown")}`);
return null;
