if (msg.payload?.code !== 0) {
    // Never include stderr, filenames or notification contents in the observer.
    node.error("NOTIFICATION_HISTORY_PURGE_FAILED");
    return null;
}
node.status({ fill: "green", shape: "dot", text: "Retenção de 7 dias aplicada" });
return null;
