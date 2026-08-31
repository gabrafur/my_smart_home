const status = msg.rtx_status || msg.payload || {};
if (status.available === true) {
    node.status({ fill: "green", shape: "dot", text: "RTX disponível" });
} else if (status.last_result === "recovery_requested") {
    node.status({ fill: "yellow", shape: "dot", text: "recovery MCP solicitado" });
} else {
    node.status({ fill: "red", shape: "ring", text: String(status.reason || status.state || "indisponível") });
}
return null;
