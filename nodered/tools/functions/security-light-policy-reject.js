const rejection = msg.security_light_policy_rejection ?? {};
node.warn("Política de iluminação rejeitada; última configuração válida preservada");
node.status({ fill: "red", shape: "ring", text: "valor inválido rejeitado" });
msg.payload = {
    contract: "security.light-policy-rejection.v1",
    kind: "configuration_rejected",
    ...rejection,
    simulated: true,
    dispatched: false
};
return msg;
