const text = String(msg.payload ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 400);
const status = text.match(/\bstatus=(accepted|coalesced)\b/)?.[1];
if (!status) {
    node.error("host_memory_guardian_request_unrecognized");
    node.status({ fill: "red", shape: "ring", text: "resposta inválida" });
    return null;
}
node.status({
    fill: status === "accepted" ? "green" : "yellow",
    shape: "dot",
    text: status === "accepted" ? "verificação aceita" : "verificação já pendente"
});
return null;
