const testMode = msg._host_memory_guardian_test === true || msg.payload?.test_mode === true;
if (testMode) {
    msg._host_memory_guardian_test = true;
    node.status({ fill: "blue", shape: "ring", text: "TESTE: host bloqueado" });
    return [null, msg];
}
if (msg.payload?.event !== "host_memory_guardian_requested") {
    node.error("host_memory_guardian_invalid_request");
    node.status({ fill: "red", shape: "ring", text: "solicitação inválida" });
    return [null, null];
}
return [msg, null];
