msg.payload = {
    ...(msg.payload && typeof msg.payload === "object" ? msg.payload : {}),
    simulated: true,
    dispatched: false,
    effect: "icloud.update"
};
node.status({
    fill: "blue",
    shape: "dot",
    text: "TESTE: iCloud não acionado"
});
return null;
